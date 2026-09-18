import { useEffect, useMemo, useState } from "react";
import {
    collection,
    doc,
    limit,
    onSnapshot,
    query,
    where,
    type Timestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import { recoverPackagingOperation } from "../../SERVICES/getAndPost/packagingMasterSheetLogger";
import "./SheetSyncStatus.css";

type SheetSyncJob = {
    id: string;
    state?: string;
    attempts?: number;
    createdAt?: Timestamp | Date | string | null;
    lastError?: string;
};

type SheetPullStatus = {
    state?: "ok" | "partial" | string;
    completedAt?: Timestamp | Date | string | null;
    startedAt?: Timestamp | Date | string | null;
    sheetsRead?: number;
    configuredSheets?: number;
    errorCount?: number;
};

type Severity = "ok" | "pending" | "warning" | "failed";

function dateFromUnknown(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "object" && value !== null && "toDate" in value) {
        const toDate = (value as { toDate?: () => Date }).toDate;
        if (typeof toDate === "function") {
            const date = toDate.call(value);
            return Number.isNaN(date.getTime()) ? null : date;
        }
    }
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
}

function ageMinutes(value: unknown, now: number): number | null {
    const date = dateFromUnknown(value);
    if (!date) return null;
    return Math.max(0, Math.floor((now - date.getTime()) / 60_000));
}

function compactAge(minutes: number | null): string {
    if (minutes === null) return "ממתין";
    if (minutes <= 0) return "נקרא עכשיו";
    if (minutes === 1) return "נקרא לפני דקה";
    return `נקרא לפני ${minutes} דק׳`;
}

function DirectionTitle({ from, to }: { from: string; to: string }) {
    return (
        <strong className="sheet-sync-direction-title" aria-label={`${from} אל ${to}`}>
            <span dir={from === "Sheets" ? "ltr" : undefined}>{from}</span>
            <span className="sheet-sync-direction-arrow" aria-hidden="true">←</span>
            <span dir={to === "Sheets" ? "ltr" : undefined}>{to}</span>
        </strong>
    );
}

export default function SheetSyncStatus() {
    const [pendingJobs, setPendingJobs] = useState<SheetSyncJob[]>([]);
    const [hasFailedJob, setHasFailedJob] = useState(false);
    const [pendingPackaging, setPendingPackaging] = useState<SheetSyncJob[]>([]);
    const [pullStatus, setPullStatus] = useState<SheetPullStatus | null>(null);
    const [readError, setReadError] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [recoveringPackagingId, setRecoveringPackagingId] = useState<string | null>(null);
    const [recoveryError, setRecoveryError] = useState<string>("");
    const isPreviewHost = typeof window !== "undefined" && window.location.hostname.includes("--pr");

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        // Do not subscribe to the complete sheetSyncJobs collection here. Failed
        // historical jobs can remain for troubleshooting, and the old broad
        // listener made every dashboard refresh download all of them again.
        // The dashboard only needs: the single pull heartbeat, every currently
        // pending job, and whether at least one failed job exists.
        let heartbeatError = false;
        let pendingError = false;
        let failedError = false;
        let packagingError = false;

        const refreshReadError = () => {
            setReadError(heartbeatError || pendingError || failedError || packagingError);
        };

        const unsubscribeHeartbeat = onSnapshot(
            doc(db, "sheetSyncJobs", "_sheetPullStatus"),
            (snapshot) => {
                heartbeatError = false;
                setPullStatus(snapshot.exists() ? snapshot.data() as SheetPullStatus : null);
                refreshReadError();
            },
            (error) => {
                console.error("Failed to subscribe to Sheet pull heartbeat:", error);
                heartbeatError = true;
                refreshReadError();
            }
        );

        const pendingQuery = query(
            collection(db, "sheetSyncJobs"),
            where("state", "==", "pending")
        );
        const unsubscribePending = onSnapshot(
            pendingQuery,
            (snapshot) => {
                pendingError = false;
                setPendingJobs(
                    snapshot.docs.map((jobDoc) => ({
                        id: jobDoc.id,
                        ...(jobDoc.data() as Omit<SheetSyncJob, "id">),
                    }))
                );
                refreshReadError();
            },
            (error) => {
                console.error("Failed to subscribe to pending Sheet sync jobs:", error);
                pendingError = true;
                refreshReadError();
            }
        );

        const packagingQuery = query(
            collection(db, "packagingOperations"),
            where("state", "==", "awaiting_pallets"),
            limit(20)
        );
        const unsubscribePackaging = onSnapshot(
            packagingQuery,
            (snapshot) => {
                packagingError = false;
                setPendingPackaging(snapshot.docs.map((operationDoc) => ({
                    id: operationDoc.id,
                    ...(operationDoc.data() as Omit<SheetSyncJob, "id">),
                })));
                refreshReadError();
            },
            (error) => {
                console.error("Failed to subscribe to pending packaging operations:", error);
                packagingError = true;
                refreshReadError();
            }
        );

        const failedQuery = query(
            collection(db, "sheetSyncJobs"),
            where("state", "==", "failed"),
            limit(1)
        );
        const unsubscribeFailed = onSnapshot(
            failedQuery,
            (snapshot) => {
                failedError = false;
                setHasFailedJob(!snapshot.empty);
                refreshReadError();
            },
            (error) => {
                console.error("Failed to subscribe to failed Sheet sync jobs:", error);
                failedError = true;
                refreshReadError();
            }
        );

        return () => {
            unsubscribeHeartbeat();
            unsubscribePending();
            unsubscribeFailed();
            unsubscribePackaging();
        };
    }, []);

    const writeStatus = useMemo(() => {
        const allPending = [...pendingJobs, ...pendingPackaging];
        const oldestPendingMinutes = allPending.reduce((oldest, job) => {
            const created = dateFromUnknown(job.createdAt);
            if (!created) return oldest;
            return Math.max(oldest, Math.max(0, Math.floor((now - created.getTime()) / 60_000)));
        }, 0);

        let severity: Severity = "ok";
        if (hasFailedJob) severity = "failed";
        else if (oldestPendingMinutes >= 30) severity = "failed";
        else if (oldestPendingMinutes >= 10) severity = "warning";
        else if (allPending.length > 0) severity = "pending";

        return { pending: allPending, sheetPending: pendingJobs.length, packagingPending: pendingPackaging.length, hasFailedJob, severity };
    }, [pendingJobs, pendingPackaging, hasFailedJob, now]);

    const pull = useMemo(() => {
        const age = ageMinutes(pullStatus?.completedAt, now);
        const errors = Number(pullStatus?.errorCount ?? 0);
        const partial = pullStatus?.state === "partial" || errors > 0;

        let severity: Severity = "ok";
        if (!pullStatus || age === null) severity = "warning";
        else if (age >= 20) severity = "failed";
        else if (age >= 10 || partial) severity = "warning";

        return { age, partial, severity };
    }, [pullStatus, now]);

    const writePill = readError
        ? "לא זמין"
        : writeStatus.hasFailedJob
            ? "יש כשל"
            : writeStatus.pending.length > 0
                ? `${writeStatus.pending.length} ממתינות${writeStatus.packagingPending > 0 ? ` · ${writeStatus.packagingPending} אריזה` : ""}`
                : "מסונכרן";

    async function recoverPackaging(operationId: string) {
        if (recoveringPackagingId) return;
        setRecoveringPackagingId(operationId);
        setRecoveryError("");
        try {
            await recoverPackagingOperation(operationId);
        } catch (error: any) {
            console.error("Failed to recover packaging operation:", error);
            setRecoveryError(error?.message ?? "שחזור המשטחים נכשל");
        } finally {
            setRecoveringPackagingId(null);
        }
    }

    const pullPill = readError
        ? "לא זמין"
        : !pullStatus && isPreviewHost
            ? "זמין אחרי merge"
            : pull.partial
                ? "קריאה חלקית"
                : compactAge(pull.age);

    return (
        <section className="sheet-sync-status" dir="rtl">
            <strong className="sheet-sync-status-title">סנכרון נתונים</strong>

            <div className="sheet-sync-direction-grid">
                <div className="sheet-sync-direction-card">
                    <DirectionTitle from="מערכת" to="Sheets" />
                    <span className={`sheet-sync-status-pill sheet-sync-status-${readError ? "warning" : writeStatus.severity}`}>
                        {writePill}
                    </span>
                </div>

                <div className="sheet-sync-direction-card">
                    <DirectionTitle from="Sheets" to="מערכת" />
                    <span className={`sheet-sync-status-pill sheet-sync-status-${readError ? "warning" : pull.severity}`}>
                        {pullPill}
                    </span>
                </div>
            </div>

            {pendingPackaging.length > 0 && (
                <div className="sheet-sync-packaging-recovery">
                    <span>יש {pendingPackaging.length} פעולות אריזה שממתינות להשלמת משטחים.</span>
                    {pendingPackaging.map((operation) => (
                        <button
                            key={operation.id}
                            type="button"
                            className="sheet-sync-recovery-button"
                            disabled={Boolean(recoveringPackagingId)}
                            onClick={() => recoverPackaging(operation.id)}
                        >
                            {recoveringPackagingId === operation.id ? "משחזר…" : "שחזר משטחים"}
                        </button>
                    ))}
                    {recoveryError && <span className="sheet-sync-recovery-error">{recoveryError}</span>}
                </div>
            )}
        </section>
    );
}
