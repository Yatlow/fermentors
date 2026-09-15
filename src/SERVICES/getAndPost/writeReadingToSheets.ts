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

function showBackgroundSheetWarning(
    readings: ReadingToSend[],
    failedResults?: writeReadingResult[]
): void {
    if (typeof document === "undefined") return;

    const failedIds = new Set(
        (failedResults ?? [])
            .map((result) => String(result.tankId ?? ""))
            .filter(Boolean)
    );

    const affected = readings.filter((reading) => {
        if (failedIds.size === 0) return true;
        return failedIds.has(String(reading.tankId ?? ""));
    });

    const tanks = affected
        .map((reading) => {
            const candidate = reading as ReadingToSend & { tankNumber?: string | number };
            return candidate.tankNumber ?? reading.tankId;
        })
        .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
        .map(String);

    const uniqueTanks = [...new Set(tanks)];
    const existing = document.getElementById("sheet-sync-warning-modal");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.id = "sheet-sync-warning-modal";
    overlay.className = "modal-overlay";
    overlay.setAttribute("dir", "rtl");

    const box = document.createElement("div");
    box.className = "modal-box";

    const title = document.createElement("h3");
    title.textContent = "אזהרה לגבי הכתיבה לגיליון";

    const text = document.createElement("p");
    const tankText = uniqueTanks.length > 0
        ? ` עבור מיכל${uniqueTanks.length > 1 ? "ים" : ""} ${uniqueTanks.join(", ")}`
        : "";
    text.textContent =
        `הפעולה נשמרה במערכת, אבל לא התקבל אישור שהכתיבה לגיליון הושלמה${tankText}. מומלץ לבדוק את הגיליון.`;

    const button = document.createElement("button");
    button.className = "btn-primary";
    button.type = "button";
    button.textContent = "הבנתי";
    button.addEventListener("click", () => overlay.remove());

    box.append(title, text, button);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
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
    // Start Firestore and Sheets together. The Firestore write is the immediate
    // application state and MUST succeed before an optimistic note/action may be
    // reported as saved. Sheets can finish in the background for note-only work.
    const optimisticFirestorePromise = pushCurrentDataToFirestore(readings);

    const sheetPromise = callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>({
        action: "addFermentationMeasurements",
        readings,
    });

    const packagingInfoPromise = syncPackagingInfoInParallel(readings);
    const noteOnlyBatch = readings.length > 0 && readings.every(isNoteOnlyReading);

    if (noteOnlyBatch) {
        // Wait only for the realtime Firestore update. If THAT write fails we
        // propagate the error and keep the normal submit flow honest. The Sheet
        // write keeps running in the background with idempotent request semantics.
        await optimisticFirestorePromise;

        void sheetPromise
            .then((parsed) => {
                if (!parsed.success) {
                    console.error(
                        "Background note Sheet sync returned failure:",
                        parsed.error || parsed.message
                    );
                    showBackgroundSheetWarning(readings);
                    return;
                }

                const results = (parsed.results as writeReadingResult[] | undefined) ?? [];
                const failed = results.filter((result) => !result.success);
                if (failed.length > 0) {
                    console.error("Background note Sheet sync partially failed:", failed);
                    showBackgroundSheetWarning(readings, failed);
                }
            })
            .catch((error) => {
                console.error("Background note Sheet sync failed:", error);
                showBackgroundSheetWarning(readings);
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
