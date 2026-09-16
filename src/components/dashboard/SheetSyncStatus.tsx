import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, type Timestamp } from "firebase/firestore";
import { db } from "../../firebase";
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
    syncErrors?: number;
    measurementErrors?: number;
    packagingErrors?: number;
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

function relativeMinutes(minutes: number | null): string {
    if (minutes === null) return "זמן לא ידוע";
    if (minutes <= 0) return "לפני פחות מדקה";
    if (minutes === 1) return "לפני דקה";
    return `לפני ${minutes} דקות`;
}

export default function SheetSyncStatus() {
    const [jobs, setJobs] = useState<SheetSyncJob[]>([]);
    const [pullStatus, setPullStatus] = useState<SheetPullStatus | null>(null);
    const [readError, setReadError] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const unsubscribe = onSnapshot(
            collection(db, "sheetSyncJobs"),
            (snapshot) => {
                setReadError(false);

                const heartbeat = snapshot.docs.find((doc) => doc.id === "_sheetPullStatus");
                setPullStatus(heartbeat ? heartbeat.data() as SheetPullStatus : null);

                setJobs(
                    snapshot.docs
                        .filter((jobDoc) => jobDoc.id !== "_sheetPullStatus")
                        .map((jobDoc) => ({
                            id: jobDoc.id,
                            ...(jobDoc.data() as Omit<SheetSyncJob, "id">),
                        }))
                );
            },
            (error) => {
                console.error("Failed to subscribe to Sheet sync status:", error);
                setReadError(true);
            }
        );
        return unsubscribe;
    }, []);

    const writeStatus = useMemo(() => {
        const failed = jobs.filter((job) => job.state === "failed");
        const pending = jobs.filter((job) => job.state === "pending");
        const oldestPendingMinutes = pending.reduce((oldest, job) => {
            const created = dateFromUnknown(job.createdAt);
            if (!created) return oldest;
            return Math.max(oldest, Math.max(0, Math.floor((now - created.getTime()) / 60_000)));
        }, 0);

        let severity: Severity = "ok";
        if (failed.length > 0) severity = "failed";
        else if (oldestPendingMinutes >= 30) severity = "failed";
        else if (oldestPendingMinutes >= 10) severity = "warning";
        else if (pending.length > 0) severity = "pending";

        return { failed, pending, oldestPendingMinutes, severity };
    }, [jobs, now]);

    const pull = useMemo(() => {
        const age = ageMinutes(pullStatus?.completedAt, now);
        const errors = Number(pullStatus?.errorCount ?? 0);
        const partial = pullStatus?.state === "partial" || errors > 0;

        let severity: Severity = "ok";
        if (!pullStatus || age === null) severity = "warning";
        else if (age >= 20) severity = "failed";
        else if (age >= 10 || partial) severity = "warning";

        return { age, errors, partial, severity };
    }, [pullStatus, now]);

    const writePill = readError
        ? "מצב לא זמין"
        : writeStatus.failed.length > 0
            ? `${writeStatus.failed.length} נכשלו`
            : writeStatus.pending.length > 0
                ? `${writeStatus.pending.length} ממתינות`
                : "מסונכרן";

    const writeText = readError
        ? "לא ניתן כרגע לקרוא את תור הכתיבות לגיליונות."
        : writeStatus.failed.length > 0
            ? "יש כתיבות מהאפליקציה ל-Sheets שלא הושלמו ודורשות בדיקה."
            : writeStatus.pending.length > 0
                ? `יש כתיבות שממתינות לאישור${writeStatus.oldestPendingMinutes > 0 ? ` עד ${writeStatus.oldestPendingMinutes} דק׳` : ""}.`
                : "כל הכתיבות מהאפליקציה ל-Sheets מסונכרנות.";

    const pullPill = readError
        ? "מצב לא זמין"
        : !pullStatus || pull.age === null
            ? "ממתין לקריאה"
            : pull.partial
                ? "קריאה חלקית"
                : relativeMinutes(pull.age);

    const pullText = readError
        ? "לא ניתן כרגע לקרוא את מצב מחזור הסנכרון מהגיליונות."
        : !pullStatus || pull.age === null
            ? "עדיין לא התקבל heartbeat ממחזור הקריאה של Apps Script."
            : pull.partial
                ? `מחזור הקריאה האחרון מהגיליונות הסתיים חלקית ${relativeMinutes(pull.age)}${pull.errors > 0 ? ` (${pull.errors} שגיאות)` : ""}.`
                : `קראתי את כל הנתונים מהגיליונות ${relativeMinutes(pull.age)}.`;

    return (
        <section className="sheet-sync-status" dir="rtl">
            <div className="sheet-sync-status-header">
                <div>
                    <strong>סנכרון נתונים</strong>
                    <span>כל כיוון נבדק בנפרד כדי לא לבלבל בין כתיבה ל-Sheets לבין קריאה מהם.</span>
                </div>
            </div>

            <div className="sheet-sync-direction-grid">
                <div className="sheet-sync-direction-card">
                    <div className="sheet-sync-direction-header">
                        <strong>אפליקציה → Sheets</strong>
                        <span className={`sheet-sync-status-pill sheet-sync-status-${readError ? "warning" : writeStatus.severity}`}>
                            {writePill}
                        </span>
                    </div>
                    <span>{writeText}</span>
                </div>

                <div className="sheet-sync-direction-card">
                    <div className="sheet-sync-direction-header">
                        <strong>Sheets → מערכת</strong>
                        <span className={`sheet-sync-status-pill sheet-sync-status-${readError ? "warning" : pull.severity}`}>
                            {pullPill}
                        </span>
                    </div>
                    <span>{pullText}</span>
                </div>
            </div>
        </section>
    );
}
