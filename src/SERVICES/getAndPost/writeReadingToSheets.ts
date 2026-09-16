import { deleteDoc, doc } from "firebase/firestore";
import type { ReadingToSend } from "../../App";
import { db } from "../../firebase";
import {
    callAppsScriptPost,
    createAppsScriptRequestId,
    type AppsScriptEnvelope,
} from "./appsScriptClient";
import { pushCurrentDataToFirestore } from "./pushCurrentDataToFirestore";

export type writeReadingResult = {
    success: boolean;
    tankId: string | number;
    message?: string;
    error?: string;
    result?: unknown;
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

function isPullRequestPreview(): boolean {
    return typeof window !== "undefined" && window.location.hostname.includes("--pr");
}

function isFirestorePermissionDenied(error: unknown): boolean {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String((error as { code?: unknown }).code) === "permission-denied";
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

async function clearSheetSyncJob(requestId: string): Promise<void> {
    try {
        await deleteDoc(doc(db, "sheetSyncJobs", requestId));
    } catch (error) {
        // The server-side maintenance worker will see the same idempotency record
        // and clean the job later. A cleanup failure must not turn a confirmed
        // successful Sheet write into a user-facing error.
        console.warn("Could not clear completed Sheet sync job", { requestId, error });
    }
}

async function persistFirestoreState(
    readings: ReadingToSend[],
    noteOnlyBatch: boolean,
    requestId: string
): Promise<void> {
    try {
        await pushCurrentDataToFirestore(readings, {
            sheetSyncRequestId: noteOnlyBatch ? requestId : undefined,
        });
    } catch (error) {
        // Firebase Hosting PR channels still use the live project's currently
        // deployed Firestore rules. Until this PR is merged, those production
        // rules do not know sheetSyncJobs yet. Keep preview testing functional
        // without weakening production durability; live builds never use this
        // fallback.
        if (noteOnlyBatch && isPullRequestPreview() && isFirestorePermissionDenied(error)) {
            console.warn(
                "PR preview cannot create sheetSyncJobs until the new Firestore rules are deployed; using preview-only fallback."
            );
            await pushCurrentDataToFirestore(readings);
            return;
        }
        throw error;
    }
}

async function reconcileConfirmedSheetResults(
    readings: ReadingToSend[],
    results: writeReadingResult[]
): Promise<void> {
    const confirmed = results
        .filter((result) => result.success && result.result)
        .map((result) => {
            const reading = readings.find(
                (candidate) => String(candidate.tankId) === String(result.tankId)
            );
            return reading
                ? { ...reading, sheetResult: result.result }
                : null;
        })
        .filter((reading): reading is ReadingToSend & { sheetResult: unknown } => Boolean(reading));

    if (confirmed.length === 0) return;
    await pushCurrentDataToFirestore(confirmed);
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
    const noteOnlyBatch = readings.length > 0 && readings.every(isNoteOnlyReading);
    const requestId = createAppsScriptRequestId("addFermentationMeasurements");

    // For note-only work the same Firestore commit that updates currentData also
    // persists an outbox job. The UI therefore stays fast, but closing Safari or
    // losing connectivity cannot silently abandon the Google Sheet write.
    const optimisticFirestorePromise = persistFirestoreState(
        readings,
        noteOnlyBatch,
        requestId
    );

    if (noteOnlyBatch) {
        // Make Firestore + outbox durable BEFORE the side effect starts. This
        // avoids the inverse partial state where Sheets succeeds but Firestore
        // failed to record either the action or its recovery job.
        await optimisticFirestorePromise;

        const sheetPromise = callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>({
            action: "addFermentationMeasurements",
            requestId,
            readings,
        });

        void sheetPromise
            .then(async (parsed) => {
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
                    return;
                }

                // Replace the optimistic overlay with the exact merged Sheet row
                // as soon as Apps Script confirms it, rather than waiting for the
                // next five-minute Sheet -> Firestore polling cycle.
                await reconcileConfirmedSheetResults(readings, results);
                await clearSheetSyncJob(requestId);
            })
            .catch((error) => {
                console.error("Background note Sheet sync failed:", error);
                showBackgroundSheetWarning(readings);
                // Keep the outbox entry pending; Apps Script maintenance will
                // retry/confirm it later with this exact same requestId.
            });

        return readings.map((reading) => ({
            success: true,
            tankId: reading.tankId,
            optimistic: true,
            requestId,
        }));
    }

    // Measurements and packaging still need their authoritative Sheet response,
    // so run Firestore, Sheets and packaging-cell sync in parallel.
    const sheetPromise = callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>({
        action: "addFermentationMeasurements",
        requestId,
        readings,
    });
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
