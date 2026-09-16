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
    requiredFieldCount?: number;
};

const RECOMMENDATION_PENALTY: Record<number, number> = {
    1: 4,
    2: 8,
    3: 14,
};

// A completely missing daily round costs eight points per tank. Partial rounds
// get proportional credit: e.g. one completed field out of four means only
// 3/4 of this penalty is applied. Completion status itself remains binary and
// is handled separately by the dashboard.
const MEASUREMENT_TANK_PENALTY = 8;

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
 * or temperature reading look missing. Conversely, a note-only row is not a
 * measurement and cannot make the daily round complete. Zero remains a valid
 * measurement value (including pressure=0).
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
        if (issue.missingFields.length === 0) return sum;

        const requestedCount = Math.round(Number(issue.requiredFieldCount) || issue.missingFields.length);
        const requiredFieldCount = Math.max(issue.missingFields.length, requestedCount, 1);
        const missingFraction = issue.missingFields.length / requiredFieldCount;

        return sum + MEASUREMENT_TANK_PENALTY * missingFraction;
    }, 0);

    return Math.max(0, Math.min(100, Math.round(100 - recommendationPenalty - measurementPenalty)));
}

export function healthBand(score: number): "healthy" | "warning" | "critical" {
    if (score >= 90) return "healthy";
    if (score >= 70) return "warning";
    return "critical";
}
