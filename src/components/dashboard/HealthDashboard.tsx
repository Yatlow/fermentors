import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Fermentor } from "../../App";
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

function tankLabel(tank: Fermentor): string {
    return String(tank.tankNumber ?? tank.uid ?? tank.id);
}

function isHotTank(tank: Fermentor): boolean {
    return tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
}

function activeRecommendations(result: Awaited<ReturnType<typeof calcCelleringRecomendations>>): Recommendation[] {
    if (!result) return [];

    // The index is deliberately an "act today" surface. Future hints stay in
    // the detailed cellar recommendation view and do not reduce today's score.
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

const severityOrder: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
};

export default function HealthDashboard({ brews, specs }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [analysis, setAnalysis] = useState<CellarAnalysis>(EMPTY_ANALYSIS);
    const [analyzing, setAnalyzing] = useState(true);

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

                        const hotTank = isHotTank(tank);
                        const requiredFieldCount = hotTank ? 4 : 2;
                        const missingFields = missingDailyMeasurementFields(
                            measurements,
                            hotTank
                        );
                        const completeMeasurements = missingFields.length === 0;

                        if (!completeMeasurements) {
                            // Completion is binary: a tank is counted as completed only
                            // when every required field exists. The score can still give
                            // proportional credit for fields that were already measured.
                            measurementIssues.push({
                                missingFields,
                                requiredFieldCount,
                            });
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
                                completeMeasurements,
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
                            completeMeasurements,
                        };
                    } catch (error) {
                        console.error("Failed calculating health for tank", tank.id, error);
                        tankAlerts.push({
                            id: `analysis-error-${tank.id}`,
                            severity: "warning",
                            title: `מיכל ${number}: בדיקת המדד לא הושלמה`,
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
                            סבב מלא: {analysis.completeMeasurementTanks}/{analysis.checkedTanks} מיכלים
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
