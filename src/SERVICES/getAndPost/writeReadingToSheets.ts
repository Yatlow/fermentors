import type { ReadingToSend } from "../../App";
import { callAppsScriptPost, type AppsScriptEnvelope } from "./appsScriptClient";
import { pushCurrentDataToFirestore } from "./pushCurrentDataToFirestore";

export type writeReadingResult = {
    success: boolean;
    tankId: string | number;
    message?: string;
    error?: string;
    [key: string]: unknown;
};

type PackagingReading = ReadingToSend & {
    isEmpty?: boolean;
    kegs?: string | number;
    crates?: string | number;
    totalLiters?: number;
    shrinkagePercent?: number;
};

function hasPackagingFields(reading: PackagingReading): boolean {
    return (
        reading.isEmpty !== undefined ||
        reading.kegs !== undefined ||
        reading.crates !== undefined ||
        reading.totalLiters !== undefined ||
        reading.shrinkagePercent !== undefined
    );
}

function isNoteOnlyReading(reading: ReadingToSend): boolean {
    const candidate = reading as PackagingReading & {
        temp?: unknown;
        pressure?: unknown;
        plato?: unknown;
        pH?: unknown;
        carbonation?: unknown;
        notes?: unknown;
        boldNotes?: unknown;
    };

    if (hasPackagingFields(candidate) || candidate.boldNotes === true) return false;

    const hasMeasurement = [
        candidate.temp,
        candidate.pressure,
        candidate.plato,
        candidate.pH,
        candidate.carbonation,
    ].some((value) => value !== undefined && value !== null && value !== "");

    const hasNotes =
        candidate.notes !== undefined &&
        candidate.notes !== null &&
        String(candidate.notes).trim() !== "";

    return !hasMeasurement && hasNotes;
}

async function syncPackagingInfoInParallel(readings: ReadingToSend[]): Promise<void> {
    const packagingReadings = readings
        .map((reading) => reading as PackagingReading)
        .filter(hasPackagingFields);

    if (packagingReadings.length === 0) return;

    const results = await Promise.allSettled(
        packagingReadings.map((reading) =>
            callAppsScriptPost<AppsScriptEnvelope<Record<string, unknown>>>({
                action: "updatePackagingInfo",
                sheetUrl: reading.sheetUrl,
                isEmpty: reading.isEmpty,
                kegs: reading.kegs,
                crates: reading.crates,
                totalLiters: reading.totalLiters,
                shrinkagePercent: reading.shrinkagePercent,
            })
        )
    );

    results.forEach((result, index) => {
        if (result.status === "rejected") {
            console.error(
                "Parallel packaging info sync failed for tank",
                packagingReadings[index]?.tankId,
                result.reason
            );
            return;
        }

        if (!result.value.success) {
            console.error(
                "Parallel packaging info sync returned failure for tank",
                packagingReadings[index]?.tankId,
                result.value.error || result.value.message
            );
        }
    });
}

export async function writeReadingsToSheets(
    readings: ReadingToSend[]
): Promise<writeReadingResult[]> {
    // Start Firestore and Sheets together. Notes/actions are intentionally
    // optimistic: the UI should not wait several seconds for Google's Web App
    // transport after Firestore already reflects the action.
    const optimisticFirestorePromise = pushCurrentDataToFirestore(readings).catch((error) => {
        console.warn("Optimistic Firestore currentData update failed:", error);
    });

    const sheetPromise = callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>({
        action: "addFermentationMeasurements",
        readings,
    });

    const packagingInfoPromise = syncPackagingInfoInParallel(readings);
    const noteOnlyBatch = readings.length > 0 && readings.every(isNoteOnlyReading);

    if (noteOnlyBatch) {
        // Wait only for the realtime Firestore update. The authoritative Sheet
        // write keeps running in the background with the same idempotent request
        // semantics. Failures are surfaced in the console but no longer hold the
        // cellar modal open for 3-5 seconds.
        await optimisticFirestorePromise;

        void sheetPromise
            .then((parsed) => {
                if (!parsed.success) {
                    console.error(
                        "Background note Sheet sync returned failure:",
                        parsed.error || parsed.message
                    );
                    return;
                }

                const results = (parsed.results as writeReadingResult[] | undefined) ?? [];
                const failed = results.filter((result) => !result.success);
                if (failed.length > 0) {
                    console.error("Background note Sheet sync partially failed:", failed);
                }
            })
            .catch((error) => {
                console.error("Background note Sheet sync failed:", error);
            });

        return readings.map((reading) => ({
            success: true,
            tankId: reading.tankId,
            optimistic: true,
        }));
    }

    const [parsed] = await Promise.all([
        sheetPromise,
        optimisticFirestorePromise,
        packagingInfoPromise,
    ]);

    if (!parsed.success) {
        throw new Error(parsed.error || parsed.message || "Batch update failed");
    }

    return (parsed.results as writeReadingResult[] | undefined) ?? [];
}
