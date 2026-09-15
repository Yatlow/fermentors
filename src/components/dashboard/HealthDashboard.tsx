import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { collection, onSnapshot, type Timestamp } from "firebase/firestore";
import type { Fermentor, FirestoreTimestamp } from "../../App";
import { db } from "../../firebase";
import {
    calcCelleringRecomendations,
    type Measurement,
} from "../../SERVICES/cellering/calculateCelleringRecomendations";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import {
    DAILY_FIELD_LABELS,
    calculateCellarHealthScore,
    healthBand,
    isActionableHealthRecommendation,
    missingDailyMeasurementFields,
    type MeasurementIssue,
    type ScoredRecommendation,
} from "../../SERVICES/dashboard/healthModel";
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

type Recommendation = {
    req?: boolean | "" | 0 | null;
    display?: boolean;
    reason?: string;
    importance?: number;
};

type CellarAnalysis = {
    alerts: HealthAlert[];
    scoreRecommendations: ScoredRecommendation[];
    measurementIssues: MeasurementIssue[];
    checkedTanks: number;
    completeMeasurementTanks: number;
};

type Props = {
    brews: Fermentor[];
    specs: SpecChart | null;
};

const EMPTY_ANALYSIS: CellarAnalysis = {
    alerts: [],
    scoreRecommendations: [],
    measurementIssues: [],
    checkedTanks: 0,
    completeMeasurementTanks: 0,
};

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

    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
}

function tankLabel(tank: Fermentor): string {
    return String(tank.tankNumber ?? tank.uid ?? tank.id);
}

function isHotTank(tank: Fermentor): boolean {
    return tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
}

function activeRecommendations(result: Awaited<ReturnType<typeof calcCelleringRecomendations>>): Recommendation[] {
    if (!result) return [];

    // Health is deliberately an "act today" surface. The recommendation engine
    // may keep req=true with display=false for useful future guidance (for
    // example "repeat carbonation tomorrow"). Those hints stay in the detailed
    // cellar recommendation view but must not become a health alert or penalty.
    const candidates: Array<Recommendation | undefined | null> = [
        result.requiresDryHop,
        result.requiresPresureClose,
        result.requiresWarmYeastDrop,
        result.requiresWarmYeastDropCompletion,
        result.requiersYeastDropAfterCooling,
        result.requiresColdYeastDropCompletion,
        result.requiiersWedYeastDropOnThus,
        result.requiresCarbTest,
        result.requiersDiacytelRest,
        result.neglectedStatus,
        result.requiresToCoolDown,
        result.requiredPressureAdjustment,
    ];

    return candidates
        .filter((recommendation): recommendation is Recommendation => Boolean(recommendation))
        .filter(isActionableHealthRecommendation)
        .sort((a, b) => Number(b.importance ?? 1) - Number(a.importance ?? 1));
}

function recommendationSeverity(importance: number): Severity {
    if (importance >= 3) return "critical";
    if (importance >= 2) return "warning";
    return "info";
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

function buildSyncAlerts(jobs: SheetSyncJob[]): HealthAlert[] {
    const now = Date.now();

    return jobs.flatMap((job) => {
        const tanks = extractJobTanks(job);
        const tanksText = tanks.length > 0
            ? `מיכל${tanks.length > 1 ? "ים" : ""} ${tanks.join(", ")}`
            : "דיווח סלרינג";

        if (job.state === "failed") {
            return [{
                id: `sync-failed-${job.id}`,
                severity: "critical" as const,
                title: `${tanksText}: סנכרון לגיליון נכשל`,
                detail: job.lastError
                    ? `לאחר ${job.attempts ?? 0} ניסיונות: ${job.lastError}`
                    : `לאחר ${job.attempts ?? 0} ניסיונות.`,
            }];
        }

        if (job.state !== "pending") return [];
        const created = dateFromUnknown(job.createdAt);
        const ageMinutes = created
            ? Math.max(0, Math.floor((now - created.getTime()) / 60_000))
            : 0;

        return [{
            id: `sync-pending-${job.id}`,
            severity: ageMinutes >= 30 ? "critical" as const : ageMinutes >= 10 ? "warning" as const : "info" as const,
            title: `${tanksText}: סנכרון לגיליון ממתין`,
            detail: ageMinutes > 0
                ? `ממתין ${ageMinutes} דקות. מנגנון ההתאוששות ימשיך לנסות אוטומטית.`
                : "נשמר במערכת וממתין לאישור הסנכרון לגיליון.",
        }];
    });
}

const severityOrder: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
};

export default function HealthDashboard({ brews, specs }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [syncJobs, setSyncJobs] = useState<SheetSyncJob[]>([]);
    const [syncReadError, setSyncReadError] = useState(false);
    const [analysis, setAnalysis] = useState<CellarAnalysis>(EMPTY_ANALYSIS);
    const [analyzing, setAnalyzing] = useState(true);

    useEffect(() => {
        const unsubscribe = onSnapshot(
            collection(db, "sheetSyncJobs"),
            (snapshot) => {
                setSyncReadError(false);
                setSyncJobs(
                    snapshot.docs.map((jobDoc) => ({
                        id: jobDoc.id,
                        ...(jobDoc.data() as Omit<SheetSyncJob, "id">),
                    }))
                );
            },
            (error) => {
                console.error("Failed to subscribe to Sheet sync health:", error);
                setSyncReadError(true);
            }
        );

        return unsubscribe;
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function analyzeCellar() {
            if (!specs) {
                if (!cancelled) {
                    setAnalysis(EMPTY_ANALYSIS);
                    setAnalyzing(true);
                }
                return;
            }

            const fullTanks = brews.filter(
                (tank) => Number(tank.tankNumber) !== 1 && Number(tank.action) === 1
            );

            setAnalyzing(true);

            const results = await Promise.all(
                fullTanks.map(async (tank) => {
                    const number = tankLabel(tank);
                    const tankAlerts: HealthAlert[] = [];
                    const scoreRecommendations: ScoredRecommendation[] = [];
                    const measurementIssues: MeasurementIssue[] = [];

                    try {
                        const measurements: Measurement[] = tank.batchNumber
                            ? await getMeasurementsByBatch(tank.batchNumber)
                            : [];

                        const missingFields = missingDailyMeasurementFields(
                            measurements,
                            isHotTank(tank)
                        );

                        if (missingFields.length > 0) {
                            measurementIssues.push({ missingFields });
                            tankAlerts.push({
                                id: `measurements-${tank.id}`,
                                severity: "warning",
                                title: `מיכל ${number}: סבב המדידות של היום לא הושלם`,
                                detail: `חסר: ${missingFields.map((field) => DAILY_FIELD_LABELS[field]).join(", ")}.`,
                                tankNumber: number,
                            });
                        }

                        if (!tank.stage || !tank.brewDate || !tank.batchNumber) {
                            tankAlerts.push({
                                id: `recommendations-unavailable-${tank.id}`,
                                severity: "info",
                                title: `מיכל ${number}: לא ניתן לחשב המלצות סלרינג`,
                                detail: "חסרים כרגע נתוני אצווה או שלב מיכל.",
                                tankNumber: number,
                            });
                            return {
                                alerts: tankAlerts,
                                scoreRecommendations,
                                measurementIssues,
                                completeMeasurements: missingFields.length === 0,
                            };
                        }

                        const recommendations = await calcCelleringRecomendations(
                            measurements,
                            tank.beerStyle,
                            tank.brewDate,
                            specs,
                            tank.stage,
                            Number(tank.tankNumber),
                            true,
                            brews
                        );

                        activeRecommendations(recommendations).forEach((recommendation, index) => {
                            const importance = Math.max(1, Math.min(3, Number(recommendation.importance) || 1));
                            scoreRecommendations.push({ importance });
                            tankAlerts.push({
                                id: `recommendation-${tank.id}-${index}`,
                                severity: recommendationSeverity(importance),
                                title: `מיכל ${number}: המלצת סלרינג`,
                                detail: recommendation.reason || "נדרשת פעולת סלרינג.",
                                tankNumber: number,
                            });
                        });

                        return {
                            alerts: tankAlerts,
                            scoreRecommendations,
                            measurementIssues,
                            completeMeasurements: missingFields.length === 0,
                        };
                    } catch (error) {
                        console.error("Failed calculating health for tank", tank.id, error);
                        tankAlerts.push({
                            id: `analysis-error-${tank.id}`,
                            severity: "warning",
                            title: `מיכל ${number}: בדיקת הבריאות לא הושלמה`,
                            detail: "לא ניתן היה לטעון או לחשב את המלצות הסלרינג למיכל.",
                            tankNumber: number,
                        });
                        return {
                            alerts: tankAlerts,
                            scoreRecommendations,
                            measurementIssues,
                            completeMeasurements: false,
                        };
                    }
                })
            );

            if (cancelled) return;

            setAnalysis({
                alerts: results
                    .flatMap((result) => result.alerts)
                    .sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]),
                scoreRecommendations: results.flatMap((result) => result.scoreRecommendations),
                measurementIssues: results.flatMap((result) => result.measurementIssues),
                checkedTanks: fullTanks.length,
                completeMeasurementTanks: results.filter((result) => result.completeMeasurements).length,
            });
            setAnalyzing(false);
        }

        void analyzeCellar();
        return () => {
            cancelled = true;
        };
    }, [brews, specs]);

    const healthScore = useMemo(
        () => calculateCellarHealthScore(
            analysis.scoreRecommendations,
            analysis.measurementIssues
        ),
        [analysis.scoreRecommendations, analysis.measurementIssues]
    );
    const overallClass = healthBand(healthScore);

    const counts = useMemo(() => ({
        critical: analysis.alerts.filter((alert) => alert.severity === "critical").length,
        warning: analysis.alerts.filter((alert) => alert.severity === "warning").length,
        info: analysis.alerts.filter((alert) => alert.severity === "info").length,
    }), [analysis.alerts]);

    const syncAlerts = useMemo(
        () => buildSyncAlerts(syncJobs).sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]),
        [syncJobs]
    );
    const pendingSyncCount = syncJobs.filter((job) => job.state === "pending").length;
    const failedSyncCount = syncJobs.filter((job) => job.state === "failed").length;
    const isPreviewHost = typeof window !== "undefined" && window.location.hostname.includes("--pr");

    const scoreStyle = {
        "--health-score": `${healthScore}%`,
    } as CSSProperties;

    const attentionCount = counts.critical + counts.warning + counts.info;

    return (
        <section className={`health-dashboard health-${overallClass}`} dir="rtl">
            <button
                type="button"
                className="health-dashboard-summary"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
            >
                <span className="health-score-ring" style={scoreStyle} aria-label={`ציון בריאות ${healthScore} מתוך 100`}>
                    <span>
                        <strong>{analyzing ? "…" : healthScore}</strong>
                        <small>/100</small>
                    </span>
                </span>

                <span className="health-summary-copy">
                    <strong>בריאות סלרינג</strong>
                    <span>
                        {analyzing
                            ? "מחשב המלצות ומדידות…"
                            : attentionCount === 0
                                ? "אין כרגע פעולות סלרינג לביצוע וסבב המדידות הושלם"
                                : `${attentionCount} דברים דורשים תשומת לב היום`}
                    </span>
                    {!analyzing && analysis.checkedTanks > 0 && (
                        <span className="health-measurement-progress">
                            סבב מדידות: {analysis.completeMeasurementTanks}/{analysis.checkedTanks} מיכלים מלאים הושלמו
                        </span>
                    )}
                </span>

                <span className="health-summary-counts">
                    {syncReadError ? (
                        <span className="health-sync-pill health-sync-warning">? מצב סנכרון לא זמין</span>
                    ) : failedSyncCount > 0 ? (
                        <span className="health-sync-pill health-sync-failed">! {failedSyncCount} סנכרונים נכשלו</span>
                    ) : pendingSyncCount > 0 ? (
                        <span className="health-sync-pill health-sync-pending">↻ {pendingSyncCount} בסנכרון</span>
                    ) : (
                        <span className="health-sync-pill health-sync-ok">✓ הכל מסונכרן</span>
                    )}

                    {counts.critical > 0 && (
                        <span className="health-count health-count-critical">{counts.critical} דחוף</span>
                    )}
                    {counts.warning > 0 && (
                        <span className="health-count health-count-warning">{counts.warning} לבדיקה</span>
                    )}
                    <span className="health-expand-indicator" aria-hidden="true">
                        {expanded ? "▴" : "▾"}
                    </span>
                </span>
            </button>

            {expanded && (
                <div className="health-dashboard-details">
                    <div className="health-score-explanation">
                        הציון מבוסס רק על המלצות סלרינג שמוצגות לביצוע היום ועל השלמת המדידות של היום. המלצה עתידית לא מוצגת כאן ולא מורידה ציון; פעולה שטופלה ונעלמה מהמלצות הסלרינג מפסיקה להוריד את הציון.
                    </div>

                    {analysis.alerts.length === 0 && !analyzing ? (
                        <div className="health-empty-state">
                            אין כרגע פעולות סלרינג לביצוע וכל המדידות הנדרשות להיום קיימות.
                        </div>
                    ) : (
                        analysis.alerts.map((alert) => (
                            <article
                                key={alert.id}
                                className={`health-alert health-alert-${alert.severity}`}
                            >
                                <span className="health-alert-icon" aria-hidden="true">
                                    {alert.severity === "critical" ? "!" : alert.severity === "warning" ? "•" : "i"}
                                </span>
                                <span className="health-alert-copy">
                                    <strong>{alert.title}</strong>
                                    <span>{alert.detail}</span>
                                </span>
                            </article>
                        ))
                    )}

                    <div className="health-sync-section">
                        <strong>סנכרון לגיליונות</strong>
                        {syncReadError ? (
                            <span>
                                {isPreviewHost
                                    ? "גרסת ה-PR משתמשת כרגע בכללי Firestore של הפרודקשן, שעדיין לא כוללים את תור הסנכרון החדש. אחרי פריסת הכללים מצב הסנכרון יהיה זמין כאן."
                                    : "לא ניתן כרגע לקרוא את מצב תור הסנכרון."}
                            </span>
                        ) : syncAlerts.length === 0 ? (
                            <span className="health-sync-ok-text">✓ הכל מסונכרן — אין סנכרוני גיליון ממתינים או כושלים.</span>
                        ) : (
                            syncAlerts.map((alert) => (
                                <article
                                    key={alert.id}
                                    className={`health-alert health-alert-${alert.severity}`}
                                >
                                    <span className="health-alert-icon" aria-hidden="true">
                                        {alert.severity === "critical" ? "!" : "↻"}
                                    </span>
                                    <span className="health-alert-copy">
                                        <strong>{alert.title}</strong>
                                        <span>{alert.detail}</span>
                                    </span>
                                </article>
                            ))
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}
