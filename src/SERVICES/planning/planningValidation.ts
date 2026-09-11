import { parseDate, weekStart, type Settings, type WeekPlan } from "./planningEngine";
import { weekday } from "./productionCycle";
import { validateTruckGroups } from "./truckPlanner";

/**
 * Validation for saved planning decisions.
 * The engine may recommend normal daily capacities (for example 252 crates),
 * but a planner is allowed to deliberately exceed that recommendation. Tank
 * volume remains a hard physical constraint in validateProduction().
 */
export function validatePlanningWeek(
  w: WeekPlan,
  settings: Settings,
  all: WeekPlan[],
  today: string,
): string | null {
  if (!Number.isInteger(w.maxRuns) || w.maxRuns < 0 || w.maxRuns > 5)
    return "מכסת האריזה חייבת להיות בין 0 ל־5";

  const days = new Map<string, string>();
  const ids = new Set<string>();
  for (const r of w.packaging) {
    const p = settings.products.find((p) => p.id === r.productId);
    if (!p || !Number.isInteger(r.quantity) || r.quantity < 0)
      return "פריט או כמות אריזה לא תקינים";
    if (r.id && ids.has(r.id)) return "מזהה אריזה כפול";
    if (r.id) ids.add(r.id);
    if (!r.quantity) continue;
    if (r.date && (!parseDate(r.date) || weekStart(r.date) !== w.id))
      return "תאריך האריזה חייב להיות בתוך השבוע";
    if (!w.allowExceptions && r.date && weekday(r.date) > 4)
      return "אין אריזה רגילה בשישי או שבת";
    if (r.date) {
      const oldProduct = days.get(r.date);
      if (!w.allowExceptions && oldProduct && oldProduct !== p.id)
        return "לא ניתן לארוז שני פריטים שונים באותו יום";
      days.set(r.date, p.id);
    }
  }

  const undated = w.packaging.filter((r) => !r.date && r.quantity > 0).length;
  if (!w.allowExceptions && days.size + undated > w.maxRuns)
    return "חריגה ממכסת ימי האריזה השבועית";

  for (const d of w.deliveries ?? []) {
    if (
      !settings.products.some((p) => p.id === d.productId) ||
      !Number.isInteger(d.quantity) ||
      d.quantity <= 0 ||
      !parseDate(d.dispatchDate) ||
      !parseDate(d.arrivalDate) ||
      weekStart(d.dispatchDate) !== w.id ||
      d.arrivalDate < d.dispatchDate
    )
      return "יש להשלים משלוח בכמות חיובית ותאריך יציאה תקין";
  }

  const truckError = validateTruckGroups(w.deliveries ?? [], settings.products, Infinity);
  if (truckError) return truckError;
  const savedIds = new Set(
    all
      .filter((x) => x.id !== w.id)
      .flatMap((x) => x.deliveries ?? [])
      .flatMap((x) => x.pallets ?? [])
      .map((x) => x.id),
  );
  if (
    (w.deliveries ?? [])
      .flatMap((x) => x.pallets ?? [])
      .some((x) => savedIds.has(x.id))
  )
    return "משטח כבר משויך למשלוח בשבוע אחר";

  for (const b of w.brews) {
    if (!w.allowExceptions && (weekday(b.date) < 1 || weekday(b.date) > 3))
      return "בישול משובץ בימים שני–רביעי בלבד";
    if (
      !parseDate(b.date) ||
      weekStart(b.date) !== w.id ||
      !b.style ||
      !b.tankId ||
      !Number.isFinite(b.liters) ||
      b.liters <= 0
    )
      return "יש להשלים שבוע, סגנון, מיכל ונפח בישול";
    if (b.date < today) return "לא ניתן ליצור בישול חדש בשבוע שכבר עבר";
  }
  return null;
}
