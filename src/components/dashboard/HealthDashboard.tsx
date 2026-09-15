import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, type Timestamp } from "firebase/firestore";
import type { Fermentor, FirestoreTimestamp } from "../../App";
import { db } from "../../firebase";
import {
    isCarbonationOutOfRange,
    isPressureOutOfRange,
} from "../../SERVICES/cellering/calculateCelleringRecomendations";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import "./HealthDashboard.css";

type Severity = "critical" | "warning" | "info";

type HealthAlert = {
    id: string;
    severity: Severity;
    title: string;
    detail: string;
    tankNumber?: string;
};

type SheetSyncJob = {
    id: string;
    state?: string;
    attempts?: number;
    readingsJson?: string;
    createdAt?: Timestamp | FirestoreTimestamp | Date | string | null;
    lastError?: string;
};

type Props = {
    brews: Fermentor[];
    specs: SpecChart | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function dateFromUnknown(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    if (typeof value === "object" && value !== null) {
        const timestamp = value as FirestoreTimestamp;
        if (typeof timestamp.toDate === "function") {
            const date = timestamp.toDate();
            return Number.isNaN(date.getTime()) ? null : date;
        }
        if (timestamp.seconds !== undefined) {
            const date = new Date(
                Number(timestamp.seconds) * 1000 +
                Math.floor(Number(timestamp.nanoseconds ?? 0) / 1_000_000)
            );
            return Number.isNaN(date.getTime()) ? null : date;
        }
    }

    const text = String(value).trim();
    if (!text) return null;

    const ymd = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ymd) {
        const date = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (dmy) {
        let year = Number(dmy[3]);
        if (year < 100) year += 2000;
        const date = new Date(year, Number(dmy[2]) - 1, Number(dmy[1]));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

function wholeDaysSince(value: unknown): number | null {
    const date = dateFromUnknown(value);
    if (!date) return null;

    const start = new Date(date);
    const today = new Date();
    start.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return Math.floor((today.getTime() - start.getTime()) / DAY_MS);
}

function isWorkdayToday(): boolean {
    const day = new Date().getDay();
    return day >= 0 && day <= 4;
}

function latestMeasurementDate(tank: Fermentor): Date | null {
    const currentData = tank.currentData as (Fermentor["currentData"] & { date?: unknown }) | null | undefined;
    return dateFromUnknown(currentData?.date);
}

function normalizeStyle(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function tankLabel(tank: Fermentor): string {
    return String(tank.tankNumber ?? tank.uid ?? tank.id);
}

function extractJobTanks(job: SheetSyncJob): string[] {
    if (!job.readingsJson) return [];
    try {
        const readings = JSON.parse(job.readingsJson) as Array<{
            tankNumber?: unknown;
            tankId?: unknown;
        }>;
        if (!Array.isArray(readings)) return [];
        return [...new Set(
            readings
                .map((reading) => String(reading.tankNumber ?? reading.tankId ?? "").trim())
                .filter(Boolean)
        )];
    } catch {
        return [];
    }
}

function buildTankAlerts(tank: Fermentor, specs: SpecChart): HealthAlert[] {
    const alerts: HealthAlert[] = [];
    const number = tankLabel(tank);
    const numericTank = Number(tank.tankNumber);
    const isClt = numericTank === 1;

    if (!isClt && !tank.stage) {
        alerts.push({
            id: `stage-${tank.id}`,
            severity: "warning",
            title: `מיכל ${number} ללא שלב מזוהה`,
            detail: "המערכת לא הצליחה לקבוע את מצב המיכל כרגע.",
            tankNumber: number,
        });
    }

    const daysSincePasivation = wholeDaysSince(tank.pasivationDate);
    const maintenanceInterval = isClt ? 180 : 90;
    const maintenanceName = isClt ? "CIP" : "חומצה ניטרית";

    if (daysSincePasivation === null) {
        alerts.push({
            id: `maintenance-missing-${tank.id}`,
            severity: "warning",
            title: `מיכל ${number}: חסר תאריך ${maintenanceName}`,
            detail: "לא ניתן לחשב את מועד התחזוקה הבא.",
            tankNumber: number,
        });
    } else {
        const remaining = maintenanceInterval - daysSincePasivation;
        if (remaining <= 0) {
            alerts.push({
                id: `maintenance-overdue-${tank.id}`,
                severity: "critical",
                title: `מיכל ${number}: ${maintenanceName} באיחור`,
                detail: remaining === 0
                    ? "הטיפול נדרש היום."
                    : `עברו ${Math.abs(remaining)} ימים מהמועד המתוכנן.`,
                tankNumber: number,
            });
        } else if (remaining <= 7) {
            alerts.push({
                id: `maintenance-soon-${tank.id}`,
                severity: "warning",
                title: `מיכל ${number}: ${maintenanceName} מתקרב`,
                detail: `נותרו ${remaining} ימים.`,
                tankNumber: number,
            });
        }
    }

    if (isClt || !tank.beerStyle) return alerts;

    const style = normalizeStyle(tank.beerStyle);
    const stageName = tank.stage?.name;
    const pressure = tank.currentData?.pressure;
    const carbonation = tank.currentData?.carbonation;

    if (isWorkdayToday() && (stageName === "בתסיסה" || stageName === "קר")) {
        const measurementDate = latestMeasurementDate(tank);
        const measurementAge = measurementDate ? wholeDaysSince(measurementDate) : null;

        if (measurementAge === null || measurementAge > 0) {
            alerts.push({
                id: `measurement-freshness-${tank.id}`,
                severity: measurementAge !== null && measurementAge >= 2 ? "critical" : "warning",
                title: `מיכל ${number}: אין מדידה מהיום`,
                detail: measurementDate
                    ? `המדידה האחרונה היא מ-${measurementDate.toLocaleDateString("he-IL")}.`
                    : "לא נמצא תאריך למדידה האחרונה.",
                tankNumber: number,
            });
        }
    }

    if (stageName === "בתסיסה" && pressure !== null && pressure !== undefined && pressure !== "") {
        const pressureStatus = isPressureOutOfRange(pressure, style, specs);
        if (pressureStatus.howBad >= 2) {
            alerts.push({
                id: `pressure-${tank.id}`,
                severity: pressureStatus.howBad >= 3 ? "critical" : "warning",
                title: `מיכל ${number}: לחץ מחוץ לטווח`,
                detail: `הקריאה האחרונה היא ${pressure} bar.`,
                tankNumber: number,
            });
        }
    }

    if (stageName === "קר" && carbonation !== null && carbonation !== undefined && carbonation !== "") {
        const carbonationStatus = isCarbonationOutOfRange(carbonation, style, specs);
        if (carbonationStatus.outOfSpec) {
            alerts.push({
                id: `carbonation-${tank.id}`,
                severity: carbonationStatus.importance >= 3 ? "critical" : "warning",
                title: `מיכל ${number}: גיזוז מחוץ לטווח`,
                detail: `הקריאה האחרונה היא ${carbonation}.`,
                tankNumber: number,
            });
        }
    }

    return alerts;
}

function buildSyncAlerts(jobs: SheetSyncJob[]): HealthAlert[] {
    const now = Date.now();
    const alerts: HealthAlert[] = [];

    jobs.forEach((job) => {
        const tanks = extractJobTanks(job);
        const tanksText = tanks.length > 0 ? `מיכל${tanks.length > 1 ? "ים" : ""} ${tanks.join(", ")}` : "דיווח סלרינג";

        if (job.state === "failed") {
            alerts.push({
                id: `sync-failed-${job.id}`,
                severity: "critical",
                title: `${tanksText}: סנכרון לגיליון נכשל`,
                detail: job.lastError
                    ? `לאחר ${job.attempts ?? 0} ניסיונות: ${job.lastError}`
                    : `לאחר ${job.attempts ?? 0} ניסיונות.`,
            });
            return;
        }

        if (job.state !== "pending") return;
        const created = dateFromUnknown(job.createdAt);
        if (!created) return;
        const ageMinutes = Math.floor((now - created.getTime()) / 60_000);
        if (ageMinutes < 10) return;

        alerts.push({
            id: `sync-pending-${job.id}`,
            severity: ageMinutes >= 30 ? "critical" : "warning",
            title: `${tanksText}: סנכרון לגיליון עדיין ממתין`,
            detail: `ממתין כבר ${ageMinutes} דקות. מנגנון ההתאוששות ימשיך לנסות אוטומטית.`,
        });
    });

    return alerts;
}

const severityOrder: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
};

export default function HealthDashboard({ brews, specs }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [syncJobs, setSyncJobs] = useState<SheetSyncJob[]>([]);

    useEffect(() => {
        const unsubscribe = onSnapshot(
            collection(db, "sheetSyncJobs"),
            (snapshot) => {
                setSyncJobs(
                    snapshot.docs.map((jobDoc) => ({
                        id: jobDoc.id,
                        ...(jobDoc.data() as Omit<SheetSyncJob, "id">),
                    }))
                );
            },
            (error) => {
                console.error("Failed to subscribe to Sheet sync health:", error);
            }
        );

        return unsubscribe;
    }, []);

    const alerts = useMemo(() => {
        if (!specs) return buildSyncAlerts(syncJobs);

        return [
            ...brews.flatMap((tank) => buildTankAlerts(tank, specs)),
            ...buildSyncAlerts(syncJobs),
        ].sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]);
    }, [brews, specs, syncJobs]);

    const counts = useMemo(() => ({
        critical: alerts.filter((alert) => alert.severity === "critical").length,
        warning: alerts.filter((alert) => alert.severity === "warning").length,
    }), [alerts]);

    const overallClass = counts.critical > 0
        ? "critical"
        : counts.warning > 0
            ? "warning"
            : "healthy";

    return (
        <section className={`health-dashboard health-${overallClass}`} dir="rtl">
            <button
                type="button"
                className="health-dashboard-summary"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
            >
                <span className="health-status-dot" aria-hidden="true" />
                <span className="health-summary-copy">
                    <strong>מצב המבשלה היום</strong>
                    <span>
                        {alerts.length === 0
                            ? "הכול נראה תקין"
                            : `${alerts.length} דברים דורשים תשומת לב`}
                    </span>
                </span>

                <span className="health-summary-counts">
                    {counts.critical > 0 && (
                        <span className="health-count health-count-critical">
                            {counts.critical} דחוף
                        </span>
                    )}
                    {counts.warning > 0 && (
                        <span className="health-count health-count-warning">
                            {counts.warning} לבדיקה
                        </span>
                    )}
                    <span className="health-expand-indicator" aria-hidden="true">
                        {expanded ? "▴" : "▾"}
                    </span>
                </span>
            </button>

            {expanded && (
                <div className="health-dashboard-details">
                    {alerts.length === 0 ? (
                        <div className="health-empty-state">
                            אין כרגע התראות פעילות.
                        </div>
                    ) : (
                        alerts.map((alert) => (
                            <article
                                key={alert.id}
                                className={`health-alert health-alert-${alert.severity}`}
                            >
                                <span className="health-alert-icon" aria-hidden="true">
                                    {alert.severity === "critical" ? "!" : "•"}
                                </span>
                                <span className="health-alert-copy">
                                    <strong>{alert.title}</strong>
                                    <span>{alert.detail}</span>
                                </span>
                            </article>
                        ))
                    )}
                </div>
            )}
        </section>
    );
}
