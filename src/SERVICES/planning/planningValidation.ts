import { parseDate, weekStart, type Settings, type WeekPlan } from "./planningEngine";
import { packagingLimit, weekday } from "./productionCycle";
import { validateTruckGroups } from "./truckPlanner";

/** Collect all distinct operational failures rather than returning only the
 * first error. The save gate compares the full before/after set, so pre-existing
 * bad history cannot hide a newly introduced failure on a different day.
 *
 * Undated weekly packaging and unassigned tank decisions are valid drafts,
 * not firm day-level commitments.
 */
export function planningWeekIssues(
  w: WeekPlan,
  settings: Settings,
  all: WeekPlan[],
  today: string,
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(w.maxRuns) || w.maxRuns < 0 || w.maxRuns > 5)
    errors.push("מכסת האריזה חייבת להיות בין 0 ל־5");

  const packagingDays = new Set<string>();
  const packagingByDay = new Map<string, { item: string; type: "crates" | "kegs"; quantity: number }[]>();
  const ids = new Set<string>();
  for (const r of w.packaging) {
    const p = settings.products.find((item) => item.id === r.productId);
    const special = !r.productId && !!r.nonInventoryStyle &&
      (r.nonInventoryType === "crates" || r.nonInventoryType === "kegs");
    if ((!p && !special) || !Number.isInteger(r.quantity) || r.quantity < 0) {
      errors.push(`אריזה ${r.id ?? "ללא מזהה"}: פריט או כמות לא תקינים`);
      continue;
    }
    if (r.id && ids.has(r.id)) errors.push(`מזהה אריזה כפול: ${r.id}`);
    if (r.id) ids.add(r.id);
    if (!r.quantity) continue;
    if (r.date && (!parseDate(r.date) || weekStart(r.date) !== w.id)) {
      errors.push(`אריזה ${r.id ?? "ללא מזהה"}: תאריך מחוץ לשבוע`);
      continue;
    }
    if (!r.date) continue;
    packagingDays.add(r.date);
    if (!w.allowExceptions && weekday(r.date) > 4)
      errors.push(`${r.date}: אין אריזה רגילה בשישי או שבת`);
    const list = packagingByDay.get(r.date) ?? [];
    list.push({
      item: p?.id ?? `special:${r.nonInventoryStyle}:${r.nonInventoryType}`,
      type: (p?.type ?? r.nonInventoryType) as "crates" | "kegs",
      quantity: r.quantity,
    });
    packagingByDay.set(r.date, list);
  }
  if (!w.allowExceptions) {
    if (packagingDays.size > w.maxRuns)
      errors.push("חריגה ממכסת ימי האריזה השבועית");
    for (const [date, runs] of packagingByDay) {
      if (new Set(runs.map((run) => run.item)).size > 1)
        errors.push(`${date}: יותר מפריט אריזה אחד ביום`);
      if (new Set(runs.map((run) => run.type)).size > 1)
        errors.push(`${date}: אין לשלב בקבוקים וחביות באותו יום`);
      for (const type of ["crates", "kegs"] as const) {
        const total = runs.filter((run) => run.type === type)
          .reduce((sum, run) => sum + run.quantity, 0);
        const cap = packagingLimit(date, type);
        if (total > cap)
          errors.push(`${date}: ${total} ${type === "crates" ? "ארגזים" : "חביות"} חורגים מקיבולת ${cap}`);
      }
    }
  }
  for (const d of w.deliveries ?? []) {
    if (!settings.products.some((p) => p.id === d.productId) ||
      !Number.isInteger(d.quantity) || d.quantity <= 0 ||
      !parseDate(d.dispatchDate) || !parseDate(d.arrivalDate) ||
      weekStart(d.dispatchDate) !== w.id || d.arrivalDate < d.dispatchDate)
      errors.push(`משלוח ${d.id}: פריט, כמות או תאריך יציאה/קליטה אינם תקינים`);
  }
  const truckError = validateTruckGroups(w.deliveries ?? [], settings.products,
    w.allowExceptions ? Infinity : (settings.maxWeeklyDeliveries ?? 2));
  if (truckError) errors.push(truckError);
  const otherPalletIds = new Set(all.filter((x) => x.id !== w.id)
    .flatMap((x) => x.deliveries ?? [])
    .flatMap((x) => x.pallets ?? []).map((x) => x.id));
  if ((w.deliveries ?? []).flatMap((x) => x.pallets ?? [])
    .some((pallet) => otherPalletIds.has(pallet.id)))
    errors.push("משטח כבר משויך למשלוח בשבוע אחר");
  for (const brew of w.brews) {
    if (!parseDate(brew.date) || weekStart(brew.date) !== w.id ||
        !brew.style || !Number.isFinite(brew.liters) || brew.liters <= 0)
      errors.push(`בישול ${brew.id}: שבוע, סגנון או נפח אינם תקינים`);
    else if (!w.allowExceptions && (weekday(brew.date) < 1 || weekday(brew.date) > 3))
      errors.push(`בישול ${brew.id}: בישול רגיל משובץ בימים שני–רביעי בלבד`);
    if (brew.date < today)
      errors.push(`בישול ${brew.id}: לא ניתן ליצור בישול חדש בעבר`);
  }
  return [...new Set(errors)];
}

export function validatePlanningWeek(
  w: WeekPlan,
  settings: Settings,
  all: WeekPlan[],
  today: string,
): string | null {
  return planningWeekIssues(w, settings, all, today)[0] ?? null;
}
