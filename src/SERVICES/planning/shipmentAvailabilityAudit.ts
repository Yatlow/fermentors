import type { Pallet } from "../cooler/Pallettypes ";
import { addDays, productPallets, parseDate, weekStart, type Actual, type Product, type Settings, type WeekPlan } from "./planningEngine";
import { openRuns } from "./dailyPlanner";
import { nominalPlanningUnits } from "./shipmentRecommendation";
import { pendingPlansAfterActualShipments } from "./shipmentActuals";
import type { ShipmentEvent } from "./dailyPlanner";

export type PlanningAvailabilityIssue = {
  week: string;
  date: string;
  productId: string;
  missing: number;
  message: string;
};

const size = (p: Product) => p.type === "crates" ? 84 : 20;

/**
 * Audit the chronological commitments against physical stock and dated, unfinished
 * packaging. Each partial physical pallet occupies one nominal pallet slot.
 * The audit is read-only and uses the same snapshots already loaded by planning.
 */
export function auditShipmentAvailability(
  settings: Settings,
  pallets: Pallet[],
  plans: WeekPlan[],
  actuals: Actual[],
  today: string,
  actualShipments: ShipmentEvent[] = [],
): PlanningAvailabilityIssue[] {
  const open = openRuns(plans, settings.products, actuals);
  // Physical stock already excludes pallets dispatched by completed shipments.
  // Do not consume that stock again for a saved trip completed today.
  const pendingPlans = pendingPlansAfterActualShipments(plans, actualShipments, settings.products);
  const issues: PlanningAvailabilityIssue[] = [];
  const horizon = addDays(weekStart(today), 91);
  for (const p of settings.products) {
    const physical = productPallets(p, pallets)
      .filter((x) => !!parseDate(x.expiryDateStr) && parseDate(x.expiryDateStr)! >= today);
    let available = physical.reduce((sum, x) => sum + nominalPlanningUnits(p, Math.max(0, Number(x.quantity) || 0)), 0);
    const events: Array<{ date: string; kind: "pack" | "ship"; qty: number; week: string }> = [];
    for (const run of open) {
      if (run.productId !== p.id || run.remaining <= 0 || !run.date || run.date < today || run.date > horizon) continue;
      events.push({ date: run.date, kind: "pack", qty: nominalPlanningUnits(p, run.remaining), week: run.week });
    }
    for (const week of pendingPlans) {
      for (const delivery of week.deliveries ?? []) {
        if (delivery.productId !== p.id || delivery.quantity <= 0 || delivery.dispatchDate < today || delivery.dispatchDate > horizon) continue;
        events.push({ date: delivery.dispatchDate, kind: "ship", qty: nominalPlanningUnits(p, delivery.quantity), week: week.id });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "pack" ? -1 : 1));
    for (const event of events) {
      if (event.kind === "pack") {
        available += event.qty;
        continue;
      }
      if (event.qty > available) {
        const missing = Math.ceil((event.qty - available) / size(p));
        issues.push({
          week: event.week,
          date: event.date,
          productId: p.id,
          missing,
          message: `משלוח ${event.date}: חסרים ${missing} משטחים של ${p.style} (${p.type === "crates" ? "ארגזים" : "חביות"})`,
        });
      }
      available = Math.max(0, available - event.qty);
    }
  }
  return issues.sort((a, b) => a.date.localeCompare(b.date) || a.productId.localeCompare(b.productId));
}
