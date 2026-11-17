import type { ConditionalForecast } from "./coldCellarForecast";
import type { ForecastRoutine } from "./forecastRoutines";
import type { ScheduledCellarRecommendation, ScheduledCellarActionType } from "./scheduledCellarRecommendations";

export type ForecastSummaryKind =
    | "carbTest" | "yeastDrop" | "dryHop" | "coolDown" | "coolingCheck"
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
    coolingCheck: "בדיקות לקראת קירור",
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
    // A readiness check is not an actual cooling action.
    if (/:cooling-(?:readiness|conditions):/.test(item.id)) return "coolingCheck";
    // The action is yeast removal even when its trigger was dry-hop.
    if (/שמרים/.test(title)) return "yeastDrop";
    if (/דרייהופ|דרי[ -]?הופ|כשות/.test(title)) return "dryHop";
    if (/גיזוז מלמטה/.test(title)) return "bottomCarbonation";
    if (/גיזוז/.test(title)) return "carbTest";
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

/** Clear, operator-facing explanations. Detailed projection math remains in
 * the original basis for diagnostics, but the UI shows the actionable reason.
 * This is purely presentational and uses no additional reads. */
export function conciseForecastExplanation(item: Pick<ConditionalForecast, "id" | "title" | "basis">): string {
    const id = item.id;
    if (id.includes(":cooling-readiness:"))
        return "הסוכר צפוי להתייצב. זה מועד לבדיקת מוכנות בלבד: לפני קירור צריך לוודא יציבות במדידות בפועל, סיום תסיסה והורדת שמרים.";
    if (id.includes(":cooling-conditions:"))
        return "התסיסה צפויה להתקרב לסיום. לפני קירור צריך להוריד שמרים ולוודא שהסוכר התייצב במדידות בפועל.";
    if (id.includes(":plato-recheck:"))
        return /דרייהופ/.test(item.title)
            ? "לפי קצב ירידת הסוכר כדאי לבדוק אם הגיע הזמן לדרייהופ. יש למדוד סוכר, לחץ וטמפרטורה לפני ביצוע."
            : "לפי קצב ירידת הסוכר כדאי לבדוק אם אפשר לסגור את המיכל. יש למדוד סוכר, לחץ וטמפרטורה לפני ביצוע.";
    if (id.includes(":diacetyl-plato-recheck:"))
        return "הסוכר צפוי להגיע לטווח המתאים. יש לבדוק גם טמפרטורה לפני מנוחת דיאצטיל.";
    if (id.includes(":diacetyl-ready:"))
        return "הסוכר והטמפרטורה האחרונים מתאימים. יש לוודא שהם עדיין מתאימים לפני ביצוע.";
    if (id.includes(":warm-yeast-after-dry-hop:"))
        return "הורדת השמרים מתוכננת לחמישה ימים אחרי הדרייהופ, אם לא בוצעה כבר.";
    if (id.includes(":non-hoppy-warm-yeast:"))
        return "כדאי לבדוק שהסוכר נמוך וירידתו האטה, ושעברו לפחות חמישה ימים מהבישול.";
    if (id.includes(":yeast-completion-"))
        return "כבר הורדו שמרים, אבל פחות מהכמות המתוכננת. יש לבדוק אם נדרשת השלמה.";
    if (id.includes(":carb-retest:"))
        return "בדיקת הגיזוז האחרונה לא הייתה תקינה. זה המועד לבדיקה חוזרת לאחר זמן ההמתנה.";
    if (id.includes(":first-carb:"))
        return "בדיקת גיזוז ראשונה ביום שאחרי הקירור, אם לא בוצעה כבר.";
    if (id.includes(":first-yeast:"))
        return "הורדת שמרים יומיים אחרי הקירור, אם לא בוצעה כבר.";
    return item.basis.trim();
}
