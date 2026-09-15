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
    // Start the optimistic Firestore update and the Google writes together.
    // Previously the Sheet request started only AFTER Firestore had completed,
    // which added a full network round trip to the user's waiting time.
    const optimisticFirestorePromise = pushCurrentDataToFirestore(readings).catch((error) => {
        console.warn("Optimistic Firestore currentData update failed:", error);
    });

    const sheetPromise = callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>({
        action: "addFermentationMeasurements",
        readings,
    });

    // Packaging has a second set of cells (empty/kegs/crates/total/shrinkage).
    // Send that mutation at the same time as the fermentation-row write instead
    // of waiting for the first Apps Script round trip to finish.
    const packagingInfoPromise = syncPackagingInfoInParallel(readings);

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
