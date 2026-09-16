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

export default function SheetSyncStatus() {
    const [jobs, setJobs] = useState<SheetSyncJob[]>([]);
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
                setJobs(
                    snapshot.docs
                        .map((jobDoc) => ({
                            id: jobDoc.id,
                            ...(jobDoc.data() as Omit<SheetSyncJob, "id">),
                        }))
                        .filter((job) => job.id !== "_sheetPullStatus")
                );
            },
            (error) => {
                console.error("Failed to subscribe to Sheet sync status:", error);
                setReadError(true);
            }
        );
        return unsubscribe;
    }, []);

    const status = useMemo(() => {
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

    return (
        <section className="sheet-sync-status" dir="rtl">
            <div className="sheet-sync-status-header">
                <div>
                    <strong>סנכרון נתונים</strong>
                    <span>מצב העברת הנתונים בין האפליקציה לגיליונות</span>
                </div>
                <span className={`sheet-sync-status-pill sheet-sync-status-${readError ? "warning" : status.severity}`}>
                    {readError
                        ? "מצב לא זמין"
                        : status.failed.length > 0
                            ? `${status.failed.length} נכשלו`
                            : status.pending.length > 0
                                ? `${status.pending.length} ממתינים`
                                : "הכל מסונכרן"}
                </span>
            </div>

            <div className="sheet-sync-direction-grid">
                <div className="sheet-sync-direction-row">
                    <strong>אפליקציה ←→ Sheets</strong>
                    <span>
                        {readError
                            ? "לא ניתן כרגע לקרוא את תור הכתיבות לגיליונות."
                            : status.failed.length > 0
                                ? "יש כתיבות שלא הושלמו ודורשות בדיקה."
                                : status.pending.length > 0
                                    ? `יש כתיבות שממתינות לאישור${status.oldestPendingMinutes > 0 ? ` עד ${status.oldestPendingMinutes} דק׳` : ""}.`
                                    : "כל הכתיבות מהאפליקציה לגיליונות אושרו."}
                    </span>
                </div>

                <div className="sheet-sync-direction-row sheet-sync-pull-info">
                    <strong>Sheets → מערכת</strong>
                    <span>
                        הסנכרון מהגיליונות אינו realtime; המחזור האוטומטי קורא את הגיליונות בערך כל 5 דקות, ולכן שינוי ידני עשוי להופיע באפליקציה בעיכוב של עד מחזור אחד.
                    </span>
                </div>
            </div>
        </section>
    );
}
