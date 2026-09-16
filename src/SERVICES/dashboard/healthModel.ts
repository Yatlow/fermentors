export type HealthMeasurement = {
    id?: string | number | null;
    date?: unknown;
    temp?: unknown;
    pressure?: unknown;
    plato?: unknown;
    pH?: unknown;
    notes?: unknown;
};

export type DailyMeasurementField = "temp" | "pressure" | "plato" | "pH";

export type ScoredRecommendation = {
    importance?: number | null;
};

export type HealthRecommendationState = {
    req?: unknown;
    display?: unknown;
};

export type MeasurementIssue = {
    missingFields: DailyMeasurementField[];
    requiredFieldCount: number;
    completedFieldCount: number;
};

const RECOMMENDATION_WEIGHT: Record<number, number> = {
    1: 2,
    2: 4,
    3: 7,
};

export const DAILY_FIELD_LABELS: Record<DailyMeasurementField, string> = {
    temp: "טמפ׳",
    pressure: "לחץ",
    plato: "Plato",
    pH: "pH",
};

/**
 * Daily health fields are measurements, so a value must actually contain a
 * finite number. This deliberately rejects visual placeholders such as "-",
 * "—" or whitespace that can arrive from old/imported Sheet rows. Zero is a
 * perfectly valid number (most importantly pressure=0).
 */
export function hasMeasurementValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string") return false;

    const text = value.trim();
    if (!text) return false;

    const numericMatch = text.match(/[-+]?\d+(?:[.,]\d+)?/);
    if (!numericMatch) return false;

    return Number.isFinite(Number(numericMatch[0].replace(",", ".")));
}

/**
 * The index is an "act now" surface, not the full cellar advice log. Future
 * recommendation hints remain available in the tank view but do not reduce
 * today's score.
 */
export function isActionableHealthRecommendation(
    recommendation: HealthRecommendationState | null | undefined
): boolean {
    return recommendation?.req === true && recommendation?.display === true;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day;
}

export function measurementDateKey(measurement: HealthMeasurement): string | null {
    const idMatch = String(measurement.id ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:_|$)/);
    if (idMatch) {
        const year = Number(idMatch[1]);
        const month = Number(idMatch[2]);
        const day = Number(idMatch[3]);
        if (!validCalendarDate(year, month, day)) return null;
        return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
    }

    const dateMatch = String(measurement.date ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!dateMatch) return null;

    let year = Number(dateMatch[3]);
    if (year < 100) year += 2000;
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[1]);
    if (!validCalendarDate(year, month, day)) return null;

    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function localDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Returns one authoritative progress object for today's round. Both the score
 * and the "full round" counter use this same result, so partial data can earn
 * credit without ever being counted as a completed round.
 */
export function dailyMeasurementProgress(
    measurements: HealthMeasurement[],
    isHotTank: boolean,
    today: Date = new Date()
): MeasurementIssue {
    const required: DailyMeasurementField[] = isHotTank
        ? ["temp", "pressure", "plato", "pH"]
        : ["temp", "pressure"];

    const todayKey = localDateKey(today);
    const todayRows = measurements.filter((measurement) => measurementDateKey(measurement) === todayKey);

    const completed = required.filter((field) =>
        todayRows.some((measurement) => hasMeasurementValue(measurement[field]))
    );

    const completedSet = new Set(completed);
    const missingFields = required.filter((field) => !completedSet.has(field));

    return {
        missingFields,
        requiredFieldCount: required.length,
        completedFieldCount: completed.length,
    };
}

export function missingDailyMeasurementFields(
    measurements: HealthMeasurement[],
    isHotTank: boolean,
    today: Date = new Date()
): DailyMeasurementField[] {
    return dailyMeasurementProgress(measurements, isHotTank, today).missingFields;
}

/**
 * Score model:
 * - every required measurement field is one earnable unit;
 * - partial rounds earn partial credit immediately (1/4 hot-round fields =
 *   exactly 1/4 of that tank's measurement contribution);
 * - actionable cellar recommendations add unresolved weighted units to the
 *   denominator. When the recommendation is handled and disappears, those
 *   unresolved units disappear too and the score rises.
 *
 * This additive model avoids the old "100 minus penalties" floor where a real
 * partial measurement could still display 0/100 simply because other tanks had
 * already exhausted the penalty budget.
 */
export function calculateCellarHealthScore(
    recommendations: ScoredRecommendation[],
    measurementProgress: MeasurementIssue[]
): number {
    const measurementPossible = measurementProgress.reduce(
        (sum, progress) => sum + Math.max(0, Number(progress.requiredFieldCount) || 0),
        0
    );

    const measurementEarned = measurementProgress.reduce((sum, progress) => {
        const required = Math.max(0, Number(progress.requiredFieldCount) || 0);
        const completed = Math.max(
            0,
            Math.min(required, Number(progress.completedFieldCount) || 0)
        );
        return sum + completed;
    }, 0);

    const unresolvedRecommendationWeight = recommendations.reduce((sum, recommendation) => {
        const importance = Math.max(1, Math.min(3, Math.round(Number(recommendation.importance) || 1)));
        return sum + RECOMMENDATION_WEIGHT[importance];
    }, 0);

    const possible = measurementPossible + unresolvedRecommendationWeight;
    if (possible <= 0) return 100;

    return Math.max(0, Math.min(100, Math.round((measurementEarned / possible) * 100)));
}

export function healthBand(score: number): "healthy" | "warning" | "critical" {
    if (score >= 90) return "healthy";
    if (score >= 70) return "warning";
    return "critical";
}
