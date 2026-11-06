import type { CellarTitleVariant } from "../dashboard/cellarRecommendationTitles";

/**
 * A purely derived, read-only "ignored" view for calendar-suppressed actions.
 * Never write these entries to ignoredCellarRecommendations/Firestore.
 * Manual ignores and daily auto-suppression retain separate lifecycles.
 */
type SuppressedRecommendation = {
  titleVariant?: CellarTitleVariant;
  req?: boolean | null;
  display?: boolean;
  autoIgnoredReason?: string | null;
  importance?: number;
  reason?: string | null;
};

type CellarRecommendationSources = {
  requiresCarbTest?: SuppressedRecommendation | null;
  neglectedStatus?: SuppressedRecommendation | null;
  requiresWarmYeastDropCompletion?: SuppressedRecommendation | null;
  requiresColdYeastDropCompletion?: SuppressedRecommendation | null;
} | null;

/**
 * Match the existing weekend auto-ignore behavior for low-priority catch-up
 * work. Keep the underlying yeast deficit visible in the ignored list and
 * restoreable for this session, without dismissing or persisting anything.
 * Only *completions* are affected, never the first yeast-drop recommendation.
 */
export function autoIgnoreYeastCompletionOnWeekend(
  recommendation: { req: boolean; display: boolean; importance: number; reason?: string },
  dayOfWeek: number,
) {
  const suppressed = (dayOfWeek === 5 || dayOfWeek === 6) &&
    recommendation.req && recommendation.display;
  return {
    ...recommendation,
    req: suppressed ? false : recommendation.req,
    display: suppressed ? false : recommendation.display,
    autoIgnoredReason: suppressed
      ? `התעלמות אוטומטית - יום ${dayOfWeek === 5 ? "שישי" : "שבת"}`
      : null,
  };
}

export type AutomaticallyIgnoredCellarRecommendation = {
  id: string;
  tankNumber: string;
  batchNumber: string;
  recommendationKey: string;
  titleVariant?: CellarTitleVariant;
  title: string;
  detail: string;
  importance: number;
  ignoredDate: string;
  autoReason: string;
};

export function automaticIgnoredRecommendationsForTank(input: {
  tankNumber: string | number;
  batchNumber: string | number;
  ignoredDate: string;
  recommendations: CellarRecommendationSources;
}): AutomaticallyIgnoredCellarRecommendation[] {
  const candidates = [
    { key: "carbTest", title: "בדיקת גיזוז", recommendation: input.recommendations?.requiresCarbTest },
    { key: "neglectedStatus", title: "טיפול במיכל", recommendation: input.recommendations?.neglectedStatus },
    { key: "warmYeastDropCompletion", title: "השלמת הורדת שמרים חמה", recommendation: input.recommendations?.requiresWarmYeastDropCompletion },
    { key: "coldYeastDropCompletion", title: "השלמת הורדת שמרים קרה", recommendation: input.recommendations?.requiresColdYeastDropCompletion },
  ];

  return candidates.flatMap(({ key, title, recommendation }) => {
    const autoReason = recommendation?.autoIgnoredReason;
    const importance = Number(recommendation?.importance);
    if (!autoReason || !Number.isFinite(importance) || importance < 1) return [];
    const tankNumber = String(input.tankNumber);
    const batchNumber = String(input.batchNumber).replace("#", "");
    return [{
      id: `auto:${input.ignoredDate}:${tankNumber}:${batchNumber}:${key}`,
      tankNumber,
      batchNumber,
      ignoredDate: input.ignoredDate,
      recommendationKey: key,
      titleVariant: recommendation?.titleVariant,
      title,
      detail: String(recommendation?.reason ?? "נדרשת פעולת סלרינג."),
      importance: Math.max(1, Math.min(3, importance)),
      autoReason,
    }];
  });
}

/** A deliberate one-day override restores an automatic reminder as actionable. */
export function partitionAutomaticallyIgnoredRecommendations(
  rows: AutomaticallyIgnoredCellarRecommendation[],
  restoredIds: ReadonlySet<string>,
): {
  ignored: AutomaticallyIgnoredCellarRecommendation[];
  restored: AutomaticallyIgnoredCellarRecommendation[];
} {
  return {
    ignored: rows.filter((row) => !restoredIds.has(row.id)),
    restored: rows.filter((row) => restoredIds.has(row.id)),
  };
}
