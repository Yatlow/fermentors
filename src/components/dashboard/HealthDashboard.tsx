import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Fermentor } from "../../App";
import {
    calcCelleringRecomendations,
    type Measurement,
} from "../../SERVICES/cellering/calculateCelleringRecomendations";
import { bottomCarbonationRecommendation } from "../../SERVICES/cellering/bottomCarbonation";
import {
    getMeasurementsByBatch,
    MEASUREMENTS_UPDATED_EVENT,
} from "../../SERVICES/getAndPost/gettAllDataByBatch";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import {
    DAILY_FIELD_LABELS,
    calculateCellarHealthScore,
    dailyMeasurementProgress,
    healthBand,
    healthActionPoints,
    isActionableHealthRecommendation,
    localDateKey,
    measurementDateKey,
    type MeasurementIssue,
    type ScoredRecommendation,
} from "../../SERVICES/dashboard/healthModel";
import {
    dueScheduledForTank,
    scheduledActionLabel,
    subscribeCompletedScheduledCellarRecommendationsToday,
    subscribeScheduledCellarRecommendations,
    type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import "./HealthDashboard.css";

type Severity = "critical" | "warning" | "info";

type HealthAlert = {
    id: string;
    severity: Severity;
    title: string;
    detail: string;
    tankNumber?: string;
};

type Recommendation = {
    req?: boolean | "" | 0 | null;
    display?: boolean;
    reason?: string;
    importance?: number;
};

type CompletedCellarAction = {
    id: string;
    tankNumber: string;
    title: string;
    detail?: string;
    importance: number;
    points: number;
};

type CellarAnalysis = {
    alerts: HealthAlert[];
    scoreRecommendations: ScoredRecommendation[];
    completedActions: CompletedCellarAction[];
    measurementProgress: MeasurementIssue[];
    checkedTanks: number;
    completeMeasurementTankNumbers: string[];
};

type Props = {
    brews: Fermentor[];
    specs: SpecChart | null;
};

const EMPTY_ANALYSIS: CellarAnalysis = {
    alerts: [],
    scoreRecommendations: [],
    completedActions: [],
    measurementProgress: [],
    checkedTanks: 0,
    completeMeasurementTankNumbers: [],
};

const FERMENTATION_MEASUREMENT_GRACE_MS = 12 * 60 * 60 * 1000;

function tankLabel(tank: Fermentor): string {
    return String(tank.tankNumber ?? tank.uid ?? tank.id);
}

function isHotTank(tank: Fermentor): boolean {
    return tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
}

function timestampToMillis(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;

    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    if (typeof value === "object") {
        const timestamp = value as {
            toDate?: () => Date;
            seconds?: unknown;
            _seconds?: unknown;
        };

        if (typeof timestamp.toDate === "function") {
            try {
                const ms = timestamp.toDate().getTime();
                if (Number.isFinite(ms)) return ms;
            } catch {
                // Fall through to raw seconds/string parsing.
            }
        }

        const seconds = Number(timestamp.seconds ?? timestamp._seconds);
        if (Number.isFinite(seconds)) return seconds * 1000;
    }

    const ms = new Date(String(value)).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * During the first 12 hours after the actual "out to fermentor" stage begins,
 * the health index has no requirements at all for this tank. If the operator
 * voluntarily records one or more numeric measurements today, the tank joins
 * the completed-round count and each measured field contributes positive score
 * only. Missing fields and cellar recommendations cannot penalize a grace tank.
 */
function isInFermentationMeasurementGracePeriod(
    tank: Fermentor,
    nowMs: number = Date.now()
): boolean {
    const startedAtMs = timestampToMillis(tank.brewProgress?.stageStartTime);
    if (startedAtMs === null) return false;

    const elapsedMs = nowMs - startedAtMs;
    return elapsedMs >= 0 && elapsedMs < FERMENTATION_MEASUREMENT_GRACE_MS;
}

function activeRecommendations(
    result: Awaited<ReturnType<typeof calcCelleringRecomendations>>,
    extras: Recommendation[] = []
): Recommendation[] {
    if (!result) return extras.filter(isActionableHealthRecommendation);

    // The index is deliberately an "act today" surface. Future hints stay in
    // the detailed cellar recommendation view and do not reduce today's score.
    const candidates: Array<Recommendation | undefined | null> = [
        ...extras,
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

const severityOrder: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
};

export default function HealthDashboard({ brews, specs }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [analysis, setAnalysis] = useState<CellarAnalysis>(EMPTY_ANALYSIS);
    const [analyzing, setAnalyzing] = useState(true);
    const [measurementRefresh, setMeasurementRefresh] = useState(0);
    const [scheduledRecommendations, setScheduledRecommendations] = useState<ScheduledCellarRecommendation[]>([]);
    const [completedScheduledToday, setCompletedScheduledToday] = useState<ScheduledCellarRecommendation[]>([]);

    useEffect(() => {
        const unsubscribeActive = subscribeScheduledCellarRecommendations(
            setScheduledRecommendations,
            (error) => console.error("Failed loading scheduled cellar recommendations for health:", error)
        );
        const unsubscribeCompleted = subscribeCompletedScheduledCellarRecommendationsToday(
            setCompletedScheduledToday,
            (error) => console.error("Failed loading completed scheduled cellar recommendations:", error)
        );
        return () => {
            unsubscribeActive();
            unsubscribeCompleted();
        };
    }, []);

    useEffect(() => {
        const refresh = () => setMeasurementRefresh((current) => current + 1);
        window.addEventListener(MEASUREMENTS_UPDATED_EVENT, refresh);
        return () => window.removeEventListener(MEASUREMENTS_UPDATED_EVENT, refresh);
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
                    const completedActions: CompletedCellarAction[] = [];
                    const hotTank = isHotTank(tank);
                    const inGracePeriod = isInFermentationMeasurementGracePeriod(tank);

                    try {
                        const measurements: Measurement[] = tank.batchNumber
                            ? await getMeasurementsByBatch(tank.batchNumber)
                            : [];

                        if (inGracePeriod) {
                            // Hot-mode progress covers all four numeric daily fields
                            // (temp/pressure/Plato/pH). We use it only to observe what
                            // was voluntarily measured; none of those fields is required.
                            const observed = dailyMeasurementProgress(measurements, true);

                            if (observed.completedFieldCount === 0) {
                                return {
                                    included: false,
                                    alerts: [] as HealthAlert[],
                                    scoreRecommendations: [] as ScoredRecommendation[],
                                    completedActions: [] as CompletedCellarAction[],
                                    measurementProgress: {
                                        missingFields: [],
                                        requiredFieldCount: 0,
                                        completedFieldCount: 0,
                                    } as MeasurementIssue,
                                    completeMeasurements: false,
                                    tankNumber: number,
                                };
                            }

                            return {
                                included: true,
                                alerts: [] as HealthAlert[],
                                scoreRecommendations: [] as ScoredRecommendation[],
                                measurementProgress: {
                                    missingFields: [],
                                    requiredFieldCount: 0,
                                    completedFieldCount: 0,
                                    bonusCompletedFieldCount: observed.completedFieldCount,
                                } as MeasurementIssue,
                                // Any voluntary numeric measurement counts as a
                                // completed round while the tank is in grace.
                                completeMeasurements: true,
                                tankNumber: number,
                            };
                        }

                        const progress = dailyMeasurementProgress(
                            measurements,
                            hotTank
                        );
                        const completeMeasurements = progress.missingFields.length === 0;

                        if (!completeMeasurements) {
                            tankAlerts.push({
                                id: `measurements-${tank.id}`,
                                severity: "warning",
                                title: `מיכל ${number}: סבב המדידות של היום לא הושלם`,
                                detail: `חסר: ${progress.missingFields.map((field) => DAILY_FIELD_LABELS[field]).join(", ")}.`,
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
                                included: true,
                                alerts: tankAlerts,
                                scoreRecommendations,
                                measurementProgress: progress,
                                completeMeasurements,
                                tankNumber: number,
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
                        const bottomCarb = tank.stage.name === "קר"
                            ? bottomCarbonationRecommendation(measurements)
                            : null;

                        const naturalRecommendations = activeRecommendations(
                            recommendations,
                            bottomCarb ? [bottomCarb] : []
                        );
                        const naturalCarb = Boolean(recommendations?.requiresCarbTest?.req);
                        const naturalYeast = Boolean(
                            recommendations?.requiresWarmYeastDrop?.req ||
                            recommendations?.requiersYeastDropAfterCooling?.req ||
                            recommendations?.requiresWarmYeastDropCompletion?.req ||
                            recommendations?.requiresColdYeastDropCompletion?.req ||
                            recommendations?.requiiersWedYeastDropOnThus?.req
                        );
                        const manualDue = dueScheduledForTank(
                            scheduledRecommendations,
                            tank.tankNumber,
                            tank.batchNumber
                        ).filter((row) =>
                            row.actionType === "carbTest" ? !naturalCarb : !naturalYeast
                        );

                        [
                            ...naturalRecommendations,
                            ...manualDue.map((row) => ({
                                req: true,
                                display: true,
                                importance: 3,
                                reason: `המלצה מתוזמנת: ${scheduledActionLabel(row.actionType)}${row.note ? ` — ${row.note}` : ""}`,
                            })),
                        ].forEach((recommendation, index) => {
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

                        const today = localDateKey(new Date());
                        const todayRows = measurements.filter((measurement) => measurementDateKey(measurement) === today);
                        const todayNotes = todayRows.map((measurement) => String(measurement.notes ?? "")).join(" | ");
                        const addCompleted = (id: string, title: string, importance = 1, detail?: string) => {
                            if (completedActions.some((action) => action.id === id)) return;
                            completedActions.push({
                                id,
                                tankNumber: number,
                                title,
                                detail,
                                importance,
                                points: healthActionPoints(importance),
                            });
                        };

                        if (todayRows.some((measurement) => Number.isFinite(Number(measurement.carbonation)))) {
                            addCompleted(`carb-${tank.id}`, "בדיקת גיזוז");
                        }
                        if (todayNotes.includes("שמרים") || todayNotes.includes("שמרי")) {
                            addCompleted(`yeast-${tank.id}`, "הורדת שמרים");
                        }
                        if (todayNotes.includes("כשות")) {
                            addCompleted(`dryhop-${tank.id}`, "דרייהופ");
                        }
                        if (todayNotes.includes("קירור")) {
                            addCompleted(`cooling-${tank.id}`, "התחלת קירור");
                        }
                        if (todayNotes.includes("גיזוז מלמטה")) {
                            addCompleted(`bottom-carb-${tank.id}`, "גיזוז מלמטה");
                        }
                        if (recommendations?.pressureAdjustmentHandledToday?.completed) {
                            const importance = Math.max(
                                1,
                                Math.min(3, Number(recommendations.pressureAdjustmentHandledToday.importance) || 1)
                            );
                            addCompleted(
                                `pressure-adjust-${tank.id}`,
                                "שינוי לחץ לאחר בדיקת גיזוז",
                                importance,
                                recommendations.pressureAdjustmentHandledToday.reason
                            );
                        }

                        completedScheduledToday
                            .filter((row) =>
                                String(row.tankNumber) === String(tank.tankNumber) &&
                                String(row.batchNumber).replace("#", "") === String(tank.batchNumber).replace("#", "")
                            )
                            .forEach((row) => {
                                addCompleted(
                                    `scheduled-${row.id}`,
                                    `המלצה ידנית: ${scheduledActionLabel(row.actionType)}`,
                                    3,
                                    row.note || undefined
                                );
                            });

                        return {
                            included: true,
                            alerts: tankAlerts,
                            scoreRecommendations,
                            completedActions,
                            measurementProgress: progress,
                            completeMeasurements,
                            tankNumber: number,
                        };
                    } catch (error) {
                        console.error("Failed calculating health for tank", tank.id, error);

                        // A grace tank cannot become a penalty just because we
                        // failed to load its optional measurements.
                        if (inGracePeriod) {
                            return {
                                included: false,
                                alerts: [] as HealthAlert[],
                                scoreRecommendations: [] as ScoredRecommendation[],
                                measurementProgress: {
                                    missingFields: [],
                                    requiredFieldCount: 0,
                                    completedFieldCount: 0,
                                } as MeasurementIssue,
                                completeMeasurements: false,
                                tankNumber: number,
                            };
                        }

                        tankAlerts.push({
                            id: `analysis-error-${tank.id}`,
                            severity: "warning",
                            title: `מיכל ${number}: בדיקת המדד לא הושלמה`,
                            detail: "לא ניתן היה לטעון או לחשב את המלצות הסלרינג למיכל.",
                            tankNumber: number,
                        });

                        const requiredFieldCount = hotTank ? 4 : 2;
                        const missingFields = hotTank
                            ? (["temp", "pressure", "plato", "pH"] as const)
                            : (["temp", "pressure"] as const);

                        return {
                            included: true,
                            alerts: tankAlerts,
                            scoreRecommendations,
                            completedActions,
                            measurementProgress: {
                                missingFields: [...missingFields],
                                requiredFieldCount,
                                completedFieldCount: 0,
                            },
                            completeMeasurements: false,
                            tankNumber: number,
                        };
                    }
                })
            );

            if (cancelled) return;

            const eligibleResults = results.filter((result) => result.included);

            setAnalysis({
                alerts: eligibleResults
                    .flatMap((result) => result.alerts)
                    .sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]),
                scoreRecommendations: eligibleResults.flatMap((result) => result.scoreRecommendations),
                completedActions: eligibleResults.flatMap((result) => result.completedActions ?? []),
                measurementProgress: eligibleResults.map((result) => result.measurementProgress),
                checkedTanks: eligibleResults.length,
                completeMeasurementTankNumbers: eligibleResults
                    .filter((result) => result.completeMeasurements)
                    .map((result) => result.tankNumber),
            });
            setAnalyzing(false);
        }

        void analyzeCellar();
        return () => {
            cancelled = true;
        };
    }, [brews, specs, measurementRefresh, scheduledRecommendations, completedScheduledToday]);

    const healthScore = useMemo(
        () => calculateCellarHealthScore(
            analysis.scoreRecommendations,
            analysis.measurementProgress,
            analysis.completedActions
        ),
        [analysis.scoreRecommendations, analysis.measurementProgress, analysis.completedActions]
    );
    const overallClass = healthBand(healthScore);

    const counts = useMemo(() => ({
        critical: analysis.alerts.filter((alert) => alert.severity === "critical").length,
        warning: analysis.alerts.filter((alert) => alert.severity === "warning").length,
        info: analysis.alerts.filter((alert) => alert.severity === "info").length,
    }), [analysis.alerts]);

    const scoreStyle = {
        "--health-score": `${healthScore}%`,
    } as CSSProperties;

    const attentionCount = counts.critical + counts.warning + counts.info;
    const completedTankCount = analysis.completeMeasurementTankNumbers.length;

    return (
        <section className={`health-dashboard health-${overallClass}`} dir="rtl">
            <button
                type="button"
                className="health-dashboard-summary"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
            >
                <span className="health-score-ring" style={scoreStyle} aria-label={`מדד סלרינג ${healthScore} מתוך 100`}>
                    <span>
                        <strong>{analyzing ? "…" : healthScore}</strong>
                        <small>/100</small>
                    </span>
                </span>

                <span className="health-summary-copy">
                    <strong>מדד סלרינג</strong>
                    <span>
                        {analyzing
                            ? "מחשב המלצות ומדידות…"
                            : attentionCount === 0
                                ? "אין כרגע פעולות סלרינג לביצוע וסבב המדידות הושלם"
                                : `${attentionCount} דברים דורשים תשומת לב היום`}
                    </span>
                    {!analyzing && analysis.checkedTanks > 0 && (
                        <span className="health-measurement-progress">
                            סבב מלא: {completedTankCount}/{analysis.checkedTanks} מיכלים
                        </span>
                    )}
                </span>

                <span className="health-summary-counts">
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
                    {analysis.completedActions.length > 0 && (
                        <section className="health-completed-actions" aria-label="פעולות שבוצעו היום">
                            <strong>בוצע היום</strong>
                            <div className="health-completed-actions-list">
                                {analysis.completedActions.map((action) => (
                                    <div className="health-completed-action" key={action.id}>
                                        <span>✓ מיכל {action.tankNumber} · {action.title}</span>
                                        <b>+{action.points}</b>
                                        {action.detail && <small>{action.detail}</small>}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
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
                </div>
            )}
        </section>
    );
}
