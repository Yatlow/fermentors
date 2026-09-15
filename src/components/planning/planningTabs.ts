export const PLANNING_TABS = [
  ["stock", "מלאי"],
  ["data", "הזנת נתונים"],
  ["calendar", "המלצות שבועיות"],
  ["schedule", "לוח עבודה יומי"],
  ["settings", "הגדרות"],
  ["tanks", "מיכלים ותזמון"],
  ["review", "תכנון מול ביצוע"],
] as const;

export type PlanningTab = (typeof PLANNING_TABS)[number][0];
