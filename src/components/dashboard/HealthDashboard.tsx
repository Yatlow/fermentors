import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { LightbulbOff, Undo2, UserShield } from "lucide-react";
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
import { getPlannedPackagingForTank } from "../../SERVICES/planning/plannedPackagingForTanks";
import {
    dueScheduledForTank,
    scheduledActionLabel,
    scheduledRecommendationCompletionDate,
    setScheduledCellarRecommendationStatus,
    subscribeCompletedScheduledCellarRecommendationsToday,
    subscribeScheduledCellarRecommendations,
    type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import {
    ignoreCellarRecommendation,
    isRecommendationIgnored,
    restoreIgnoredCellarRecommendation,
    subscribeIgnoredCellarRecommendationsToday,
    type IgnoredCellarRecommendation,
} from "../../SERVICES/cellering/ignoredCellarRecommendations";
import BeerCelebration from "../../COMPONENTS/BeerCelebration";
import "./HealthDashboard.css";

type Severity = "critical" | "warning" | "info";

type HealthAlert = {
    id: string;
    severity: Severity;
    title: string;
    detail: string;
    tankNumber?: string;
    batchNumber?: string;
    recommendationKey?: string;
    importance?: number;
    dismissible?: boolean;
    userDecision?: boolean;
};

type Recommendation = {
    req?: boolean | "" | 0 | null;
    display?: boolean;
    reason?: string;
    importance?: number;
    userDecision?: boolean;
};

type KeyedRecommendation = Recommendation & {
    recommendationKey: string;
};

type CompletedCellarAction = {
    id: string;
    tankNumber: string;
    title: string;
    detail?: string;
    importance: number;
    points: number;
};

type DailyCellarAction = {
    id: string;
    tankNumber: string;
    title: string;
    detail?: string;
    /** False when the same physical action is already represented by a scored recommendation. */
    scoreEligible?: boolean;
};

type DailyActionProgress = {
    yeastRequired: number;
    yeastCompleted: number;
    carbRequired: number;
    carbCompleted: number;
};

type CellarAnalysis = {
    alerts: HealthAlert[];
    scoreRecommendations: ScoredRecommendation[];
    completedActions: CompletedCellarAction[];
    dailyActions: DailyCellarAction[];
    dailyActionProgress: DailyActionProgress;
    measurementProgress: MeasurementIssue[];
    checkedTanks: number;
    completeMeasurementTankNumbers: string[];
};

type Props = {
    brews: Fermentor[];
    specs: SpecChart | null;
};

const EMPTY_DAILY_ACTION_PROGRESS: DailyActionProgress = {
    yeastRequired: 0,
    yeastCompleted: 0,
    carbRequired: 0,
    carbCompleted: 0,
};

const EMPTY_ANALYSIS: CellarAnalysis = {
    alerts: [],
    scoreRecommendations: [],
    completedActions: [],
    dailyActions: [],
    dailyActionProgress: EMPTY_DAILY_ACTION_PROGRESS,
    measurementProgress: [],
    checkedTanks: 0,
    completeMeasurementTankNumbers: [],
};

const FERMENTATION_MEASUREMENT_GRACE_MS = 12 * 60 * 60 * 1000;

function recommendationShortLabel(key: string, fallback = "המלצת סלרינג"): string {
    if (key === "measurementRound") return "סבב מדידות";
    if (key === "dryHop") return "דרייהופ";
    if (key === "pressureClose") return "סגירת לחץ";
    if (key === "warmYeastDrop" || key === "warmYeastDropCompletion") return "הורדת שמרים";
    if (key === "yeastDropAfterCooling" || key === "coldYeastDropCompletion" || key === "wedYeastDropOnThu") return "הורדת שמרים";
    if (key === "carbTest") return "בדיקת גיזוז";
    if (key === "bottomCarbonation" || key === "bottomCarbonationFollowUp") return "גיזוז מלמטה";
    if (key === "diacetylRest") return "מנוחת דיאצטיל";
    if (key === "neglectedStatus") return "טיפול במיכל";
    if (key === "coolDown") return "קירור";
    if (key === "pressureAdjustment") return "שינוי לחץ";
    if (key.startsWith("scheduled-")) return "המלצה מתוזמנת";
    return fallback;
}

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

function isInFermentationMeasurementGracePeriod(
    tank: Fermentor,
    nowMs: number = Date.now()
): boolean {
    // Grace starts when the tank actually enters ACTION 1. Brew-progress
    // stageStartTime can describe an earlier brewing step and must not age the
    // fermentation measurement grace before beer reaches the tank.
    const startedAtMs = timestampToMillis(
        (tank as Fermentor & { fermentationStartedAt?: unknown }).fermentationStartedAt
    );
    if (startedAtMs === null) return false;

    const elapsedMs = nowMs - startedAtMs;
    return elapsedMs >= 0 && elapsedMs < FERMENTATION_MEASUREMENT_GRACE_MS;
}

function activeRecommendations(
    result: Awaited<ReturnType<typeof calcCelleringRecomendations>>,
    extras: Array<{ recommendationKey: string; recommendation: Recommendation }> = []
): KeyedRecommendation[] {
    const candidates: Array<{ recommendationKey: string; recommendation?: Recommendation | null }> = [
        ...extras,
        { recommendationKey: "dryHop", recommendation: result?.requiresDryHop },
        { recommendationKey: "pressureClose", recommendation: result?.requiresPresureClose },
        { recommendationKey: "warmYeastDrop", recommendation: result?.requiresWarmYeastDrop },
        { recommendationKey: "warmYeastDropCompletion", recommendation: result?.requiresWarmYeastDropCompletion },
        { recommendationKey: "yeastDropAfterCooling", recommendation: result?.requiersYeastDropAfterCooling },
        { recommendationKey: "coldYeastDropCompletion", recommendation: result?.requiresColdYeastDropCompletion },
        { recommendationKey: "wedYeastDropOnThu", recommendation: result?.requiiersWedYeastDropOnThus },
        { recommendationKey: "carbTest", recommendation: result?.requiresCarbTest },
        { recommendationKey: "bottomCarbonation", recommendation: result?.requiredBottomCarbonation },
        { recommendationKey: "diacetylRest", recommendation: result?.requiersDiacytelRest },
        { recommendationKey: "neglectedStatus", recommendation: result?.neglectedStatus },
        { recommendationKey: "coolDown", recommendation: result?.requiresToCoolDown },
        { recommendationKey: "pressureAdjustment", recommendation: result?.requiredPressureAdjustment },
    ];

    const active = candidates
        .filter((item): item is { recommendationKey: string; recommendation: Recommendation } => Boolean(item.recommendation))
        .filter((item) => isActionableHealthRecommendation(item.recommendation))
        .map((item) => ({ ...item.recommendation, recommendationKey: item.recommendationKey }))
        .sort((a, b) => Number(b.importance ?? 1) - Number(a.importance ?? 1));

    const yeastKeys = new Set([
        "warmYeastDrop",
        "warmYeastDropCompletion",
        "yeastDropAfterCooling",
        "coldYeastDropCompletion",
        "wedYeastDropOnThu",
    ]);
    const highestPriorityYeast = active.find((item) => yeastKeys.has(item.recommendationKey));
    return active.filter((item) =>
        !yeastKeys.has(item.recommendationKey) || item === highestPriorityYeast
    );
}

function recommendationSeverity(importance: number): Severity {
    if (importance >= 3) return "critical";
    if (importance >= 2) return "warning";
    return "info";
}

function isCalendarCarbRecommendation(recommendation: Recommendation | null | undefined): boolean {
    if (!recommendation?.req || !recommendation?.display) return false;
    const reason = String(recommendation.reason ?? "");
    return /יום ראשון|לפי נתוני היומן|אתמול לא בוצעה/.test(reason);
}

const severityOrder: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
};

export default function HealthDashboard({ brews, specs, onRecommendedTanksChange }: Props & { onRecommendedTanksChange?: (numbers: string[]) => void }) {
    const [expanded, setExpanded] = useState(false);
    const [analysis, setAnalysis] = useState<CellarAnalysis>(EMPTY_ANALYSIS);
    const graceSnapshotTank = brews.find((tank) => Number(tank.tankNumber) === 1) as
        | (Fermentor & { cellarHealthCompletedDay?: string; cellarGraceTankIds?: string[] })
        | undefined;
    const graceLockedIds = graceSnapshotTank?.cellarHealthCompletedDay === localDateKey(new Date())
        ? (graceSnapshotTank.cellarGraceTankIds ?? [])
        : [];
    const [analyzing, setAnalyzing] = useState(true);
    const [measurementRefresh, setMeasurementRefresh] = useState(0);
    const [scheduledRecommendations, setScheduledRecommendations] = useState<ScheduledCellarRecommendation[]>([]);
    const [completedScheduledToday, setCompletedScheduledToday] = useState<ScheduledCellarRecommendation[]>([]);
    const [ignoredRecommendations, setIgnoredRecommendations] = useState<IgnoredCellarRecommendation[]>([]);
    const [ignoreSavingId, setIgnoreSavingId] = useState<string | null>(null);
    const autoResolvedScheduledIds = useRef(new Set<string>());

    useEffect(() => {
        const unsubscribeActive = subscribeScheduledCellarRecommendations(
            setScheduledRecommendations,
            (error) => console.error("Failed loading scheduled cellar recommendations for health:", error)
        );
        const unsubscribeCompleted = subscribeCompletedScheduledCellarRecommendationsToday(
            setCompletedScheduledToday,
            (error) => console.error("Failed loading completed scheduled cellar recommendations:", error)
        );
        const unsubscribeIgnored = subscribeIgnoredCellarRecommendationsToday(
            setIgnoredRecommendations,
            (error) => console.error("Failed loading ignored cellar recommendations for health:", error)
        );
        return () => {
            unsubscribeActive();
            unsubscribeCompleted();
            unsubscribeIgnored();
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
                    const dailyActions: DailyCellarAction[] = [];
                    const tankDailyProgress: DailyActionProgress = { ...EMPTY_DAILY_ACTION_PROGRESS };
                    const hotTank = isHotTank(tank);
                    const inGracePeriod = isInFermentationMeasurementGracePeriod(tank);
                    const graceMeasurementExempt = graceLockedIds.includes(String(tank.id));

                    try {
                        const measurements: Measurement[] = tank.batchNumber
                            ? await getMeasurementsByBatch(tank.batchNumber)
                            : [];

                        if (inGracePeriod) {
                            const observed = dailyMeasurementProgress(measurements, true);

                            if (observed.completedFieldCount === 0) {
                                return {
                                    included: false,
                                    alerts: [] as HealthAlert[],
                                    scoreRecommendations: [] as ScoredRecommendation[],
                                    completedActions: [] as CompletedCellarAction[],
                                    dailyActions: [] as DailyCellarAction[],
                                    dailyActionProgress: tankDailyProgress,
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
                                completedActions: [] as CompletedCellarAction[],
                                dailyActions: [] as DailyCellarAction[],
                                dailyActionProgress: tankDailyProgress,
                                measurementProgress: {
                                    missingFields: [],
                                    requiredFieldCount: 0,
                                    completedFieldCount: 0,
                                    bonusCompletedFieldCount: observed.completedFieldCount,
                                } as MeasurementIssue,
                                completeMeasurements: true,
                                tankNumber: number,
                            };
                        }

                        const progress = dailyMeasurementProgress(measurements, hotTank);
                        const completeMeasurements = progress.missingFields.length === 0;
                        const measurementRoundIgnored = Boolean(
                            tank.batchNumber &&
                            isRecommendationIgnored(
                                ignoredRecommendations,
                                String(tank.tankNumber),
                                String(tank.batchNumber),
                                "measurementRound"
                            )
                        );
                        const scoreProgress = (measurementRoundIgnored || graceMeasurementExempt)
                            ? { ...progress, missingFields: [], requiredFieldCount: progress.completedFieldCount }
                            : progress;

                        if (!completeMeasurements && !measurementRoundIgnored && !graceMeasurementExempt) {
                            tankAlerts.push({
                                id: `measurements-${tank.id}`,
                                severity: "warning",
                                title: `מיכל ${number}: סבב המדידות של היום לא הושלם`,
                                detail: `חסר: ${progress.missingFields.map((field) => DAILY_FIELD_LABELS[field]).join(", ")}.`,
                                tankNumber: number,
                                batchNumber: String(tank.batchNumber ?? ""),
                                recommendationKey: "measurementRound",
                                importance: 2,
                                dismissible: Boolean(tank.batchNumber),
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
                                completedActions,
                                dailyActions,
                                dailyActionProgress: tankDailyProgress,
                                measurementProgress: scoreProgress,
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
                            bottomCarb
                                ? [{ recommendationKey: "bottomCarbonationFollowUp", recommendation: bottomCarb }]
                                : []
                        ).filter((recommendation) =>
                            // Neglect is a weekday-only reminder; other recommendations remain available.
                            !(recommendation.recommendationKey === "neglectedStatus" &&
                              [5, 6].includes(new Date().getDay()))
                        );

                        const now = new Date();
                        const today = localDateKey(now);
                        const day = now.getDay();
                        const todayRows = measurements.filter(
                            (measurement) => measurementDateKey(measurement) === today
                        );
                        const todayNotes = todayRows
                            .map((measurement) => String(measurement.notes ?? ""))
                            .join(" | ");
                        const hasTodayCarbonation = todayRows.some((measurement) =>
                            measurement.carbonation !== null &&
                            measurement.carbonation !== undefined &&
                            measurement.carbonation !== "" &&
                            Number.isFinite(Number(measurement.carbonation))
                        );
                        const hasTodayYeast = /שמרים|שמרי/.test(todayNotes);
                        const hasTodayCooling = /קירור/.test(todayNotes);
                        const handledPressureAfterCarb =
                            recommendations?.pressureAdjustmentHandledToday?.completed === true;
                        const carbCompletedToday = hasTodayCarbonation || handledPressureAfterCarb;

                        const naturalCarb = Boolean(
                            recommendations?.requiresCarbTest?.req &&
                            recommendations?.requiresCarbTest?.display
                        );
                        const naturalYeastKeys = new Set([
                            "warmYeastDrop",
                            "warmYeastDropCompletion",
                            "yeastDropAfterCooling",
                            "coldYeastDropCompletion",
                            "wedYeastDropOnThu",
                        ]);
                        // Keep the KPI denominator aligned with what the dashboard
                        // actually presents. In particular, completion/catch-up
                        // yeast recommendations must count as a required yeast action.
                        const naturalYeast = naturalRecommendations.some(
                            (recommendation) => naturalYeastKeys.has(recommendation.recommendationKey)
                        );

                        const dueScheduled = dueScheduledForTank(
                            scheduledRecommendations,
                            tank.tankNumber,
                            tank.batchNumber
                        );
                        const scheduledCompletionDates = new Map(
                            dueScheduled.map((row) => [
                                row.id,
                                scheduledRecommendationCompletionDate(row, measurements),
                            ])
                        );
                        const effectivelyCompletedScheduled = dueScheduled.filter(
                            (row) => Boolean(scheduledCompletionDates.get(row.id))
                        );
                        effectivelyCompletedScheduled.forEach((row) => {
                            const completionDate = scheduledCompletionDates.get(row.id);
                            if (!completionDate || autoResolvedScheduledIds.current.has(row.id)) return;
                            autoResolvedScheduledIds.current.add(row.id);
                            void setScheduledCellarRecommendationStatus(row.id, "completed", completionDate)
                                .catch((error) => {
                                    autoResolvedScheduledIds.current.delete(row.id);
                                    console.error("Failed auto-completing scheduled cellar recommendation:", error);
                                });
                        });

                        const effectivelyCompletedIds = new Set(
                            effectivelyCompletedScheduled.map((row) => row.id)
                        );
                        const unresolvedScheduled = dueScheduled.filter(
                            (row) => !effectivelyCompletedIds.has(row.id)
                        );
                        const hasActiveUserPressureDecision = unresolvedScheduled.some(
                            (row) => row.actionType === "pressureChange"
                        );
                        const manualDue = unresolvedScheduled.filter((row) => {
                            if (row.actionType === "pressureChange") return true;
                            return row.actionType === "carbTest" ? !naturalCarb : !naturalYeast;
                        });

                        let packagingToday = false;
                        if (day === 0 && tank.stage.name === "קר") {
                            try {
                                const plannedPackaging = await getPlannedPackagingForTank({
                                    tankId: tank.id,
                                    tankNumber: tank.tankNumber,
                                    batchNumber: tank.batchNumber,
                                });
                                packagingToday = plannedPackaging?.date === today;
                            } catch (error) {
                                // Planning metadata should never break cellar analysis.
                                // If it cannot be loaded, keep the established Sunday routine.
                                console.warn("Failed checking today's packaging plan for cellar routine:", error);
                            }
                        }

                        const sundayColdAction =
                            day === 0 &&
                            tank.stage.name === "קר" &&
                            !hasTodayCooling &&
                            !packagingToday;
                        const wednesdayCarbAction =
                            day === 3 && isCalendarCarbRecommendation(recommendations?.requiresCarbTest);
                        const thursdayYeastAction =
                            day === 4 &&
                            recommendations?.requiiersWedYeastDropOnThus?.req === true &&
                            recommendations?.requiiersWedYeastDropOnThus?.display === true;
                        const scheduledCarbAction = unresolvedScheduled.some(
                            (row) => row.actionType === "carbTest"
                        );
                        const scheduledYeastAction = unresolvedScheduled.some(
                            (row) => row.actionType === "yeastDrop"
                        );

                        // Ignored cellar recommendations must not reappear as weekly
                        // actions or remain in the daily KPI denominator.
                        const ignoredForToday = (key: string) => isRecommendationIgnored(
                            ignoredRecommendations,
                            String(tank.tankNumber),
                            String(tank.batchNumber),
                            key
                        );
                        const carbRecommendationKeys = [
                            "carbTest", "bottomCarbonationFollowUp",
                            ...unresolvedScheduled.filter((row) => row.actionType === "carbTest")
                                .map((row) => `scheduled-${row.id}`),
                        ];
                        const yeastRecommendationKeys = [
                            ...naturalYeastKeys,
                            ...unresolvedScheduled.filter((row) => row.actionType === "yeastDrop")
                                .map((row) => `scheduled-${row.id}`),
                        ];
                        const carbIgnored = carbRecommendationKeys.some(ignoredForToday);
                        const yeastIgnored = yeastRecommendationKeys.some(ignoredForToday);

                        const carbRequiredToday =
                            sundayColdAction ||
                            wednesdayCarbAction ||
                            naturalCarb ||
                            scheduledCarbAction ||
                            carbCompletedToday;
                        const yeastRequiredToday =
                            sundayColdAction ||
                            thursdayYeastAction ||
                            naturalYeast ||
                            scheduledYeastAction ||
                            hasTodayYeast;

                        tankDailyProgress.carbRequired = carbRequiredToday && !carbIgnored ? 1 : 0;
                        tankDailyProgress.carbCompleted = carbRequiredToday && !carbIgnored && carbCompletedToday ? 1 : 0;
                        tankDailyProgress.yeastRequired = yeastRequiredToday && !yeastIgnored ? 1 : 0;
                        tankDailyProgress.yeastCompleted = yeastRequiredToday && !yeastIgnored && hasTodayYeast ? 1 : 0;

                        const weeklyCarbAction = sundayColdAction || wednesdayCarbAction;
                        const weeklyYeastAction = sundayColdAction || thursdayYeastAction;

                        if (weeklyCarbAction && !carbCompletedToday && !carbIgnored) {
                            dailyActions.push({
                                id: `daily-carb-${tank.id}`,
                                tankNumber: number,
                                title: "בדיקת גיזוז",
                                detail: sundayColdAction
                                    ? "פעולת יום ראשון לכל מיכל קר"
                                    : "מתוכנן לרדת בשבוע הבא",
                                // Wednesday/scheduled/natural carb work is already
                                // represented in scoreRecommendations. Only add a
                                // separate score unit for the standalone Sunday routine.
                                scoreEligible: sundayColdAction && !naturalCarb && !scheduledCarbAction,
                            });
                        }
                        if (weeklyYeastAction && !hasTodayYeast && !yeastIgnored) {
                            dailyActions.push({
                                id: `daily-yeast-${tank.id}`,
                                tankNumber: number,
                                title: "הורדת שמרים",
                                detail: sundayColdAction
                                    ? "פעולת יום ראשון לכל מיכל קר"
                                    : "מתוכנן לרדת בשבוע הבא",
                                // Thursday/scheduled/natural yeast work is already
                                // scored as a recommendation. The pure Sunday routine
                                // needs its own low-priority score unit.
                                scoreEligible: sundayColdAction && !naturalYeast && !scheduledYeastAction,
                            });
                        }

                        [
                            ...naturalRecommendations.filter(
                                (recommendation) => !(
                                    hasActiveUserPressureDecision &&
                                    recommendation.recommendationKey === "pressureAdjustment"
                                )
                            ),
                            ...manualDue.map((row) => ({
                                recommendationKey: `scheduled-${row.id}`,
                                req: true,
                                display: true,
                                importance: 3,
                                userDecision: row.source === "user" || row.actionType === "pressureChange",
                                reason: row.source === "user" || row.actionType === "pressureChange"
                                    ? `החלטת סלרינג: ${row.note || `יש לבצע ${scheduledActionLabel(row.actionType)}`}`
                                    : `המלצה מתוזמנת: ${scheduledActionLabel(row.actionType)}${row.note ? ` — ${row.note}` : ""}`,
                            })),
                        ].forEach((recommendation) => {
                            if (isRecommendationIgnored(
                                ignoredRecommendations,
                                String(tank.tankNumber),
                                String(tank.batchNumber),
                                recommendation.recommendationKey
                            )) return;

                            const importance = Math.max(1, Math.min(3, Number(recommendation.importance) || 1));
                            scoreRecommendations.push({ importance });
                            tankAlerts.push({
                                id: `recommendation-${tank.id}-${recommendation.recommendationKey}`,
                                severity: recommendationSeverity(importance),
                                title: recommendation.userDecision
                                    ? `מיכל ${number}: החלטת סלרינג`
                                    : `מיכל ${number}: המלצת סלרינג`,
                                detail: recommendation.reason || "נדרשת פעולת סלרינג.",
                                tankNumber: number,
                                batchNumber: String(tank.batchNumber),
                                recommendationKey: recommendation.recommendationKey,
                                importance,
                                dismissible: true,
                                userDecision: recommendation.userDecision,
                            });
                        });

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

                        const completedScheduledForTank = completedScheduledToday.filter((row) =>
                            String(row.tankNumber) === String(tank.tankNumber) &&
                            String(row.batchNumber).replace("#", "") === String(tank.batchNumber).replace("#", "")
                        );
                        const completedScheduledIds = new Set(
                            completedScheduledForTank.map((row) => row.id)
                        );
                        const effectivelyCompletedScheduledToday = effectivelyCompletedScheduled.filter(
                            (row) => scheduledCompletionDates.get(row.id) === today
                        );
                        const scheduledCompletedForDisplay = [
                            ...completedScheduledForTank,
                            ...effectivelyCompletedScheduledToday.filter((row) => !completedScheduledIds.has(row.id)),
                        ];
                        const completedScheduledCarb = scheduledCompletedForDisplay.some(
                            (row) => row.actionType === "carbTest"
                        );
                        const completedScheduledYeast = scheduledCompletedForDisplay.some(
                            (row) => row.actionType === "yeastDrop"
                        );
                        const completedScheduledPressure = scheduledCompletedForDisplay.some(
                            (row) => row.actionType === "pressureChange"
                        );

                        scheduledCompletedForDisplay.forEach((row) => {
                            const isDecision = row.source === "user" || row.actionType === "pressureChange";
                            addCompleted(
                                `scheduled-${row.id}`,
                                scheduledActionLabel(row.actionType),
                                1,
                                isDecision
                                    ? `בוצע לפי החלטת סלרינג${row.note ? ` · ${row.note}` : ""}`
                                    : row.note
                                        ? `בוצע לפי המלצה מתוזמנת · ${row.note}`
                                        : "בוצע לפי המלצה מתוזמנת"
                            );
                        });

                        if (carbCompletedToday && !completedScheduledCarb) {
                            addCompleted(`carb-${tank.id}`, "בדיקת גיזוז");
                        }
                        if (hasTodayYeast && !completedScheduledYeast) {
                            addCompleted(`yeast-${tank.id}`, "הורדת שמרים");
                        }
                        // Reports submitted in the app are persisted in the day's measurement notes.
                        // Recognize explicit action labels, avoiding broad words such as "לחץ" or "חום".
                        const reportedActions = [
                            { key: "vent-adjust", label: "כיוון פורק", pattern: /כיוון פורק|כיוון הפורק|כיוונתי פורק/ },
                            { key: "pressure-close", label: "סגירת נשם / מיכל", pattern: /סגירת נשם|סגירת הנשם|סגירת מיכל|סגרתי נשם/ },
                            { key: "diacetyl", label: "מנוחת דיאצטיל", pattern: /מנוחת דיאצ[י׳']?טיל|דיאצטיל/ },
                            { key: "pressure-change", label: "שינוי לחץ", pattern: /שינוי לחץ|שיניתי לחץ|שינוי בלחץ/ },
                            { key: "other", label: "פעולה אחרת", pattern: /(?:^|[|\\n])\\s*אחר\\s*[:：-]/ },
                        ];
                        reportedActions.forEach(({ key, label, pattern }) => {
                            if (pattern.test(todayNotes)) addCompleted(`reported-${key}-${tank.id}`, label);
                        });
                        if (todayNotes.includes("כשות")) addCompleted(`dryhop-${tank.id}`, "דרייהופ");
                        if (todayNotes.includes("קירור")) addCompleted(`cooling-${tank.id}`, "התחלת קירור");
                        if (todayNotes.includes("גיזוז מלמטה")) addCompleted(`bottom-carb-${tank.id}`, "גיזוז מלמטה");
                        if (recommendations?.pressureAdjustmentHandledToday?.completed && !completedScheduledPressure) {
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

                        return {
                            included: true,
                            alerts: tankAlerts,
                            scoreRecommendations,
                            completedActions,
                            dailyActions,
                            dailyActionProgress: tankDailyProgress,
                            measurementProgress: scoreProgress,
                            completeMeasurements,
                            tankNumber: number,
                        };
                    } catch (error) {
                        console.error("Failed calculating health for tank", tank.id, error);

                        if (inGracePeriod) {
                            return {
                                included: false,
                                alerts: [] as HealthAlert[],
                                scoreRecommendations: [] as ScoredRecommendation[],
                                completedActions: [] as CompletedCellarAction[],
                                dailyActions: [] as DailyCellarAction[],
                                dailyActionProgress: tankDailyProgress,
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
                            dailyActions,
                            dailyActionProgress: tankDailyProgress,
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
            const dailyActionProgress = eligibleResults.reduce<DailyActionProgress>(
                (sum, result) => ({
                    yeastRequired: sum.yeastRequired + result.dailyActionProgress.yeastRequired,
                    yeastCompleted: sum.yeastCompleted + result.dailyActionProgress.yeastCompleted,
                    carbRequired: sum.carbRequired + result.dailyActionProgress.carbRequired,
                    carbCompleted: sum.carbCompleted + result.dailyActionProgress.carbCompleted,
                }),
                { ...EMPTY_DAILY_ACTION_PROGRESS }
            );

            setAnalysis({
                alerts: eligibleResults
                    .flatMap((result) => result.alerts)
                    .sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]),
                scoreRecommendations: eligibleResults.flatMap((result) => result.scoreRecommendations),
                completedActions: eligibleResults.flatMap((result) => result.completedActions ?? []),
                dailyActions: eligibleResults.flatMap((result) => result.dailyActions ?? []),
                dailyActionProgress,
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
    }, [brews, specs, measurementRefresh, scheduledRecommendations, completedScheduledToday, ignoredRecommendations]);

    const recommendedTankKey = useMemo(() => [...new Set(analysis.alerts
        .filter((alert) => alert.recommendationKey && alert.recommendationKey !== "measurementRound")
        .map((alert) => String(alert.tankNumber)))].sort().join(","), [analysis.alerts]);
    useEffect(() => {
        if (!analyzing) onRecommendedTanksChange?.(recommendedTankKey ? recommendedTankKey.split(",") : []);
    }, [analyzing, recommendedTankKey, onRecommendedTanksChange]);

    const pendingDailyScoreActionCount = useMemo(
        () => analysis.dailyActions.filter((action) => action.scoreEligible !== false).length,
        [analysis.dailyActions]
    );

    const healthScore = useMemo(
        () => calculateCellarHealthScore(
            analysis.scoreRecommendations,
            analysis.measurementProgress,
            analysis.completedActions,
            pendingDailyScoreActionCount
        ),
        [
            analysis.scoreRecommendations,
            analysis.measurementProgress,
            analysis.completedActions,
            pendingDailyScoreActionCount,
        ]
    );
    const displayedHealthScore = healthScore;
    const overallClass = healthBand(displayedHealthScore);
    const previousSettledScoreRef = useRef<number | null>(null);
    const persistedHealthWriteRef = useRef<boolean | null>(null);
    const [celebrationOpen, setCelebrationOpen] = useState(false);
    const cellarStateTank = useMemo(
        () => brews.find((tank) => Number(tank.tankNumber) === 1) as
            | (Fermentor & { cellarHealthIs100?: boolean; cellarHealthCompletedDay?: string })
            | undefined,
        [brews]
    );
    const persistedHealthIs100 = cellarStateTank?.cellarHealthIs100 === true;

    useEffect(() => {
        if (analyzing || !cellarStateTank?.id) return;

        previousSettledScoreRef.current = healthScore;
        const todayKey = localDateKey(new Date());
        // A completed daily round stays completed through the end of its day.
        // A new fermentation tank leaving its 12-hour grace must not reopen it.
        const desiredIs100 = healthScore === 100;

        // Tank 1 is already part of the app's fermentor listener, so this gives
        // the celebration a tiny shared state without adding another listener/read.
        // It is written only when the score crosses the 100 boundary.
        if (persistedHealthIs100 === desiredIs100) {
            persistedHealthWriteRef.current = null;
            return;
        }
        if (persistedHealthWriteRef.current === desiredIs100) return;
        persistedHealthWriteRef.current = desiredIs100;

        const shouldCelebrate =
            desiredIs100 &&
            !persistedHealthIs100;

        const timer = window.setTimeout(() => {
            if (previousSettledScoreRef.current !== healthScore) return;
            void updateDoc(doc(db, "fermentors", String(cellarStateTank.id)), {
                cellarHealthIs100: desiredIs100,
                ...(desiredIs100 ? {
                    cellarHealthCompletedDay: todayKey,
                    cellarGraceTankIds: brews.filter((tank) =>
                        Number(tank.tankNumber) !== 1 &&
                        Number(tank.action) === 1 &&
                        isInFermentationMeasurementGracePeriod(tank)
                    ).map((tank) => String(tank.id)),
                } : {}),
            }).then(() => {
                if (shouldCelebrate) setCelebrationOpen(true);
            }).catch((error) => {
                persistedHealthWriteRef.current = null;
                console.error("Failed persisting cellar health celebration state:", error);
            });
        }, 1200);

        return () => window.clearTimeout(timer);
    }, [
        analyzing,
        healthScore,
        cellarStateTank?.id,
        persistedHealthIs100,
        brews,
    ]);

    const counts = useMemo(() => ({
        critical: analysis.alerts.filter((alert) => alert.severity === "critical").length,
        warning: analysis.alerts.filter((alert) => alert.severity === "warning").length,
        info: analysis.alerts.filter((alert) => alert.severity === "info").length,
    }), [analysis.alerts]);

    const groupedDailyActions = useMemo(() => {
        const grouped = new Map<string, { tankNumber: string; titles: string[]; detail?: string }>();
        analysis.dailyActions.forEach((action) => {
            const existing = grouped.get(action.tankNumber);
            if (!existing) {
                grouped.set(action.tankNumber, {
                    tankNumber: action.tankNumber,
                    titles: [action.title],
                    detail: action.detail,
                });
                return;
            }
            if (!existing.titles.includes(action.title)) existing.titles.push(action.title);
            if (!existing.detail && action.detail) existing.detail = action.detail;
        });
        return Array.from(grouped.values()).sort(
            (a, b) => Number(a.tankNumber) - Number(b.tankNumber)
        );
    }, [analysis.dailyActions]);

    const scoreStyle = {
        "--health-score": `${displayedHealthScore}%`,
    } as CSSProperties;

    const attentionCount = counts.critical + counts.warning + counts.info;
    const completedTankCount = analysis.completeMeasurementTankNumbers.length;

    async function ignoreAlert(alert: HealthAlert) {
        if (!alert.dismissible || !alert.tankNumber || !alert.batchNumber || !alert.recommendationKey) return;
        setIgnoreSavingId(alert.id);
        try {
            await ignoreCellarRecommendation({
                tankNumber: alert.tankNumber,
                batchNumber: alert.batchNumber,
                recommendationKey: alert.recommendationKey,
                title: recommendationShortLabel(alert.recommendationKey, alert.title),
                detail: alert.detail,
                importance: alert.importance ?? 1,
            });
        } catch (error) {
            console.error("Failed ignoring cellar recommendation:", error);
        } finally {
            setIgnoreSavingId(null);
        }
    }

    async function restoreIgnored(row: IgnoredCellarRecommendation) {
        setIgnoreSavingId(row.id);
        try {
            await restoreIgnoredCellarRecommendation(row.id);
        } catch (error) {
            console.error("Failed restoring cellar recommendation:", error);
        } finally {
            setIgnoreSavingId(null);
        }
    }

    return (
        <>
        <BeerCelebration open={celebrationOpen} onClose={() => setCelebrationOpen(false)} />
        <section className={`health-dashboard health-${overallClass}`} dir="rtl">
            <button
                type="button"
                className="health-dashboard-summary"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
            >
                <span className="health-score-ring" style={scoreStyle} aria-label={`מדד סלרינג ${displayedHealthScore} מתוך 100`}>
                    <span>
                        <strong>{analyzing ? "…" : displayedHealthScore}</strong>
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
                    {!analyzing && (
                        <span className="health-measurement-progress">
                            פעולות היום: שמרים {analysis.dailyActionProgress.yeastCompleted}/{analysis.dailyActionProgress.yeastRequired}
                            {" · "}
                            גיזוזים {analysis.dailyActionProgress.carbCompleted}/{analysis.dailyActionProgress.carbRequired}
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

                    {ignoredRecommendations.length > 0 && (
                        <section className="health-ignored-actions" aria-label="המלצות שסומנו להתעלם היום">
                            <strong>סומן להתעלם</strong>
                            <div className="health-ignored-actions-list">
                                {ignoredRecommendations.map((row) => (
                                    <div className="health-ignored-action" key={row.id}>
                                        <span>
                                            <LightbulbOff size={15} aria-hidden="true" />
                                            מיכל {row.tankNumber} · {recommendationShortLabel(row.recommendationKey, row.title)}
                                        </span>
                                        <button
                                            type="button"
                                            className="health-restore-button"
                                            disabled={ignoreSavingId === row.id}
                                            onClick={() => void restoreIgnored(row)}
                                            title="החזר המלצה"
                                            aria-label={`החזר המלצה למיכל ${row.tankNumber}`}
                                        >
                                            <Undo2 size={15} aria-hidden="true" />
                                            החזר
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {groupedDailyActions.length > 0 && (
                        <section className="health-daily-actions" aria-label="פעולות יומיות לביצוע">
                            <strong>פעולות יומיות לביצוע</strong>
                            <div className="health-daily-actions-list">
                                {groupedDailyActions.map((action) => (
                                    <div className="health-daily-action" key={`daily-${action.tankNumber}`}>
                                        <span>מיכל {action.tankNumber} · {action.titles.join(", ")}</span>
                                        {action.detail && <small>{action.detail}</small>}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {analysis.alerts.some((alert) => alert.recommendationKey === "measurementRound") && (
                        <section className="health-daily-actions health-required-measurements" aria-label="מדידות נדרשות">
                            <strong>מדידות נדרשות</strong>
                            <div className="health-daily-actions-list">
                                {analysis.alerts.filter((alert) => alert.recommendationKey === "measurementRound").map((alert) => (
                                    <div className="health-daily-action" key={alert.id}>
                                        <span>מיכל {alert.tankNumber} · {alert.detail}</span>
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
                        analysis.alerts.filter((alert) => alert.recommendationKey !== "measurementRound").map((alert) => (
                            <article
                                key={alert.id}
                                className={`health-alert health-alert-${alert.severity}${alert.userDecision ? " health-alert-user-decision" : ""}`}
                            >
                                <span className="health-alert-icon" aria-hidden="true">
                                    {alert.userDecision
                                        ? <UserShield size={14} aria-hidden="true" />
                                        : alert.severity === "critical"
                                            ? "!"
                                            : alert.severity === "warning"
                                                ? "•"
                                                : "i"}
                                </span>
                                <span className="health-alert-copy">
                                    <strong>{alert.title}</strong>
                                    <span>{alert.detail}</span>
                                </span>
                                {alert.dismissible && (
                                    <button
                                        type="button"
                                        className="health-ignore-button"
                                        disabled={ignoreSavingId === alert.id}
                                        onClick={() => void ignoreAlert(alert)}
                                        title="התעלם מההמלצה להיום"
                                        aria-label={`התעלם מההמלצה למיכל ${alert.tankNumber} להיום`}
                                    >
                                        <LightbulbOff size={17} aria-hidden="true" />
                                    </button>
                                )}
                            </article>
                        ))
                    )}
                </div>
            )}
        </section>
        </>
    );
}
