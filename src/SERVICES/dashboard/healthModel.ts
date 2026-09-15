export type HealthMeasurement = {
    id?: string | number | null;
    date?: unknown;
    temp?: unknown;
    pressure?: unknown;
    plato?: unknown;
    pH?: unknown;
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
};

const RECOMMENDATION_PENALTY: Record<number, number> = {
    1: 4,
    2: 8,
    3: 14,
};

const MEASUREMENT_FIELD_PENALTY: Record<DailyMeasurementField, number> = {
    temp: 3,
    pressure: 3,
    plato: 2,
    pH: 2,
};

export const DAILY_FIELD_LABELS: Record<DailyMeasurementField, string> = {
    temp: "טמפ׳",
    pressure: "לחץ",
    plato: "Plato",
    pH: "pH",
};

export function hasMeasurementValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== "";
}

/**
 * The health dashboard is an "act now" surface, not the full cellar advice log.
 * Some recommendation objects intentionally keep req=true while display=false so
 * the detailed tank view can explain what will be needed tomorrow. Those future
 * hints must not become health alerts or reduce today's score.
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
 * Checks today's complete cellar round across all rows from today. This is
 * deliberate: a later action/note row must not make an earlier valid pressure
 * or temperature reading look missing. Zero is a valid measurement value.
 */
export function missingDailyMeasurementFields(
    measurements: HealthMeasurement[],
    isHotTank: boolean,
    today: Date = new Date()
): DailyMeasurementField[] {
    const required: DailyMeasurementField[] = isHotTank
        ? ["temp", "pressure", "plato", "pH"]
        : ["temp", "pressure"];

    const todayKey = localDateKey(today);
    const todayRows = measurements.filter((measurement) => measurementDateKey(measurement) === todayKey);

    return required.filter((field) =>
        !todayRows.some((measurement) => hasMeasurementValue(measurement[field]))
    );
}

export function calculateCellarHealthScore(
    recommendations: ScoredRecommendation[],
    measurementIssues: MeasurementIssue[]
): number {
    const recommendationPenalty = recommendations.reduce((sum, recommendation) => {
        const importance = Math.max(1, Math.min(3, Math.round(Number(recommendation.importance) || 1)));
        return sum + RECOMMENDATION_PENALTY[importance];
    }, 0);

    const measurementPenalty = measurementIssues.reduce((sum, issue) => {
        // Missing the daily round is one operational issue per tank. The first
        // missing required field costs 4 points; additional missing fields add
        // only their small field weight so one tank cannot dominate the score.
        if (issue.missingFields.length === 0) return sum;
        const extra = issue.missingFields
            .slice(1)
            .reduce((fieldSum, field) => fieldSum + MEASUREMENT_FIELD_PENALTY[field], 0);
        return sum + 4 + extra;
    }, 0);

    return Math.max(0, Math.min(100, 100 - recommendationPenalty - measurementPenalty));
}

export function healthBand(score: number): "healthy" | "warning" | "critical" {
    if (score >= 90) return "healthy";
    if (score >= 70) return "warning";
    return "critical";
}
