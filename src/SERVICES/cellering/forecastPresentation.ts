import type { ConditionalForecast } from "./coldCellarForecast";
import type { ForecastRoutine } from "./forecastRoutines";
import type { ScheduledCellarRecommendation, ScheduledCellarActionType } from "./scheduledCellarRecommendations";

export type ForecastSummaryKind =
    | "carbTest" | "yeastDrop" | "dryHop" | "coolDown"
    | "bottomCarbonation" | "pressureChange" | "diacetyl"
    | "fermentationCheck" | "other";

export type ForecastSummaryGroup = {
    kind: ForecastSummaryKind;
    count: number;
    label: string;
};

export type ForecastDayExecutiveSummary = {
    total: number;
    conditionalCount: number;
    groups: ForecastSummaryGroup[];
};

const LABELS: Record<ForecastSummaryKind, string> = {
    carbTest: "בדיקות גיזוז",
    yeastDrop: "הורדות שמרים",
    dryHop: "דרייהופ",
    coolDown: "קירור",
    bottomCarbonation: "גיזוז מלמטה",
    pressureChange: "שינויי לחץ",
    diacetyl: "מנוחות דיאצטיל",
    fermentationCheck: "בדיקות תסיסה",
    other: "פעולות נוספות",
};

const ORDER = Object.keys(LABELS) as ForecastSummaryKind[];

function scheduledKind(type: ScheduledCellarActionType): ForecastSummaryKind {
    return type === "carbTest" || type === "yeastDrop" ||
        type === "bottomCarbonation" || type === "coolDown" || type === "pressureChange"
        ? type : "other";
}

/** Categorize the visible *forecast entries*, not the brewing style. A
 * conditional dry-hop readiness check is never treated as executed dry hop. */
export function conditionalForecastKind(item: Pick<ConditionalForecast, "title" | "id">): ForecastSummaryKind {
    const title = item.title;
    if (/דרייהופ|דרי[ -]?הופ|כשות/.test(title)) return "dryHop";
    if (/גיזוז מלמטה/.test(title)) return "bottomCarbonation";
    if (/גיזוז/.test(title)) return "carbTest";
    if (/שמרים/.test(title)) return "yeastDrop";
    if (/דיאצטיל|דיאציטיל/.test(title)) return "diacetyl";
    if (/קירור/.test(title)) return "coolDown";
    if (/לחץ/.test(title)) return "pressureChange";
    if (/תסיסה|סגירת מיכל|פלאטו/.test(title)) return "fermentationCheck";
    return "other";
}

/** Deterministic summary of the same deduplicated rows shown in the day.
 * Projection and routine rows count as forecast items, not completed actions. */
export function summarizeCellaringForecastDay(input: {
    scheduledRows: readonly Pick<ScheduledCellarRecommendation, "actionType">[];
    conditionalRows: readonly Pick<ConditionalForecast, "title" | "id">[];
    routines: readonly Pick<ForecastRoutine, "actionType" | "source">[];
}): ForecastDayExecutiveSummary {
    const counts = new Map<ForecastSummaryKind, number>();
    const count = (kind: ForecastSummaryKind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);

    input.scheduledRows.forEach((row) => count(scheduledKind(row.actionType)));
    input.conditionalRows.forEach((row) => count(conditionalForecastKind(row)));
    input.routines.forEach((row) => count(scheduledKind(row.actionType)));

    return {
        total: input.scheduledRows.length + input.conditionalRows.length + input.routines.length,
        conditionalCount: input.conditionalRows.length +
            input.routines.filter((row) => row.source === "sunday-predicted-cold").length,
        groups: ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
            kind,
            count: counts.get(kind)!,
            label: LABELS[kind],
        })),
    };
}

/** Hide verbose forecasting jargon in the scan view while preserving the
 * original explanation behind a separate, optional 'למה?' disclosure. */
export function conciseForecastTitle(title: string): string {
    return title.trim()
        .replace(/^צפי ל(.+?) — בדיקת תנאים$/, "בדיקת תנאים: $1")
        .replace(/^בדיקת תנאים ל/, "בדיקת תנאים: ");
}
