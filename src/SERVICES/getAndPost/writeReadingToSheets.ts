import { deleteDoc, doc } from "firebase/firestore";
import type { ReadingToSend } from "../../App";
import { db } from "../../firebase";
import {
    callAppsScriptPost,
    AppsScriptInvalidResponseError,
    AppsScriptTimeoutError,
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

// Diagnostics are best-effort and never affect the operation or its outbox.
function reportSheetSyncDiagnostic(requestId: string, phase: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    const kind = error instanceof Error ? error.name : "NonError";
    console.warn("Sheet sync diagnostic", { requestId, phase, kind, message });
    void callAppsScriptPost({
        action: "ClientSheetSyncDiagnostic",
        requestId: createAppsScriptRequestId("sheet-sync-diagnostic"),
        originalRequestId: requestId,
        phase,
        errorType: kind.slice(0, 80),
        errorMessage: message.slice(0, 300),
    }, { retries: 0, timeoutMs: 10000 }).catch((diagnosticError) => {
        console.warn("Sheet sync diagnostic upload unavailable", { requestId, phase, diagnosticError });
    });
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
    durableMeasurementBatch: boolean,
    requestId: string
): Promise<void> {
    // PR Hosting previews run against the currently deployed production
    // Firestore rules. Those rules do not know PR #27's new sheetSyncJobs
    // write shape yet. Previously we deliberately tried the durable write,
    // waited for permission-denied, then retried without the outbox. That made
    // every note/action report in Preview pay an unnecessary failed network
    // round-trip. Skip that known-to-fail write up front in Preview.
    if (durableMeasurementBatch && isPullRequestPreview()) {
        await pushCurrentDataToFirestore(readings);
        return;
    }

    try {
        await pushCurrentDataToFirestore(readings, {
            sheetSyncRequestId: durableMeasurementBatch ? requestId : undefined,
        });
    } catch (error) {
        if (durableMeasurementBatch && isPullRequestPreview() && isFirestorePermissionDenied(error)) {
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

    if (confirmed.length !== readings.length) {
        throw new Error("Sheet confirmed without a complete authoritative measurement result");
    }
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
                requestId: createAppsScriptRequestId(`updatePackagingInfo-${reading.tankId}`),
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
    const durableMeasurementBatch = readings.length > 0;
    const requestId = createAppsScriptRequestId("addFermentationMeasurements");

    // Every cellar/packaging measurement is committed to Firestore together with a
    // durable outbox job before the Sheet side effect starts. The UI stays fast,
    // and closing Safari or losing connectivity cannot abandon the Sheet write.
    const optimisticFirestorePromise = persistFirestoreState(
        readings,
        durableMeasurementBatch,
        requestId
    );

    if (durableMeasurementBatch) {
        // Make Firestore + outbox durable BEFORE the side effect starts. This
        // avoids the inverse partial state where Sheets succeeds but Firestore
        // failed to record either the action or its recovery job.
        await optimisticFirestorePromise;

        const sheetPromise = callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>({
            action: "addFermentationMeasurements",
            requestId,
            readings,
        });

        // Packaging-cell metadata is independent from the fermentation row and
        // should never keep the reporting UI open. It is idempotent and can run
        // alongside the background Sheet write.
        void syncPackagingInfoInParallel(readings);

        void sheetPromise
            .then(async (parsed) => {
                if (!parsed.success) {
                    console.error("Background cellar Sheet sync returned failure:", parsed.error || parsed.message);
                    reportSheetSyncDiagnostic(requestId, "server-rejected", parsed.error || parsed.message);
                    showBackgroundSheetWarning(readings);
                    return;
                }

                const results = (parsed.results as writeReadingResult[] | undefined) ?? [];
                const failed = results.filter((result) => !result.success);
                if (failed.length > 0) {
                    console.error("Background cellar Sheet sync partially failed:", failed);
                    reportSheetSyncDiagnostic(requestId, "partial-sheet-failure", failed.map(item => item.error || item.message).join("; "));
                    showBackgroundSheetWarning(readings, failed);
                    return;
                }

                // Never acknowledge the recovery job until authoritative
                // Firestore history has actually been committed.
                try {
                    await reconcileConfirmedSheetResults(readings, results);
                } catch (error) {
                    reportSheetSyncDiagnostic(requestId, "post-confirmation-reconcile", error);
                    console.error("Sheet write confirmed but Firestore reconciliation failed:", error);
                    showBackgroundSheetWarning(readings);
                    return;
                }
                await clearSheetSyncJob(requestId);
            })
            .catch((error) => {
                console.error("Background cellar Sheet sync failed:", error);
                reportSheetSyncDiagnostic(requestId, "sheet-response-unconfirmed", error);
                // A timeout, malformed Google redirect response, or network loss
                // cannot establish whether Sheets succeeded. The durable outbox
                // already confirms the exact requestId in its regular maintenance
                // cycle; the existing live status listener shows pending/failed.
                // Never present a false write-failure modal for an unknown result.
                const unconfirmedTransport = error instanceof AppsScriptTimeoutError ||
                    error instanceof AppsScriptInvalidResponseError ||
                    (error instanceof TypeError && /fetch|network|load/i.test(error.message));
                if (!unconfirmedTransport) {
                    showBackgroundSheetWarning(readings);
                }
                // Keep the outbox entry pending for server-side confirmation.
            });

        return readings.map((reading) => ({
            success: true,
            tankId: reading.tankId,
            optimistic: true,
            requestId,
        }));
    }

    return [];
}
