import type { Pallet } from "../cooler/Pallettypes ";
import { addDays, productPallets, parseDate, weekStart, type Actual, type Product, type Settings, type WeekPlan } from "./planningEngine";
import { openRuns, type ShipmentEvent } from "./dailyPlanner";
import { addForecastPackaging, dispatchForecastPallets, type ForecastPalletLot } from "./shipmentPalletLedger";
import { pendingPlansAfterActualShipments } from "./shipmentActuals";

export type PlanningAvailabilityIssue = {
  week: string;
  date: string;
  productId: string;
  /** Missing pallet positions, not missing actual units. */
  missing: number;
  /** Partial pallets can cover planned pallet positions without fulfilling the quantity. */
  missingUnits?: number;
  severity?: "blocking" | "partial";
  message: string;
};

const size = (p: Product) => p.type === "crates" ? 84 : 20;



/**
 * Audit planned dispatches in date order. Two ledgers must be kept separately:
 * pallet positions (partial pallet occupies a whole position) and ACTUAL units.
 * Physical pallets expire at the dispatch date, not at today's date.
 * Future packaging has unknown expiry and is eligible only after its planned
 * packaging date. Reports already completed are removed by openRuns.
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
  const pending = pendingPlansAfterActualShipments(plans, actualShipments, settings.products);
  const issues: PlanningAvailabilityIssue[] = [];
  const horizon = addDays(weekStart(today), 91);

  for (const product of settings.products) {
    const unitPerPallet = size(product);
    const lots: ForecastPalletLot[] = productPallets(product, pallets).flatMap((pallet) => {
      const expiry = parseDate(pallet.expiryDateStr);
      const physical = Math.max(0, Number(pallet.quantity) || 0);
      if (!expiry || expiry < today || physical <= 0) return [];
      return [{ id: pallet.id, expiry, quantity: physical }];
    });
    const events: Array<{
      date: string; kind: "pack" | "ship"; qty: number; week: string;
    }> = [];
    for (const run of open) {
      if (run.productId !== product.id || run.remaining <= 0 ||
          !run.date || run.date < today || run.date > horizon) continue;
      events.push({ date: run.date, kind: "pack", qty: run.remaining, week: run.week });
    }
    for (const week of pending) {
      for (const delivery of week.deliveries ?? []) {
        if (delivery.productId !== product.id || delivery.quantity <= 0 ||
            delivery.dispatchDate < today || delivery.dispatchDate > horizon) continue;
        events.push({ date: delivery.dispatchDate, kind: "ship", qty: delivery.quantity, week: week.id });
      }
    }
    events.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === "pack" ? -1 : 1));

    for (const event of events) {
      // A pallet is not ship-ready after its own expiry date. This also
      // prevents it being used for a later shipment simply because it was
      // valid on the day the planner opened the dashboard.
      for (let i = lots.length - 1; i >= 0; i--) {
        if (lots[i].expiry < event.date) lots.splice(i, 1);
      }
      if (event.kind === "pack") {
        // Unproduced stock is a forecast only, but its loading positions still
        // behave like physical indivisible pallets in the simulation.
        addForecastPackaging(lots, event.qty, unitPerPallet,
          `future:${event.week}:${event.date}:${product.id}`);
        continue;
      }
      const { missingSlots: missing, missingUnits } = dispatchForecastPallets(
        lots, event.qty, unitPerPallet, event.date,
      );
      if (missing > 0) {
        issues.push({
          week: event.week, date: event.date, productId: product.id,
          missing, missingUnits, severity: "blocking",
          message: `משלוח ${event.date}: חסרים ${missing} מקומות משטח זמינים של ${product.style} (${product.type === "crates" ? "ארגזים" : "חביות"}); יש לבדוק גם תוקף מלאי`,
        });
      } else if (missingUnits > 0.001) {
        issues.push({
          week: event.week, date: event.date, productId: product.id,
          missing: 0, missingUnits, severity: "partial",
          message: `משלוח ${event.date}: חסרות ${Math.ceil(missingUnits)} יחידות ${product.style} בפועל. משטח חלקי מכסה מקום במשאית, לא את כמות ההזמנה`,
        });
      }
    }
  }
  return issues.sort((a, b) => a.date.localeCompare(b.date) ||
    a.productId.localeCompare(b.productId));
}

/** A partial pallet is operationally permitted but must never be invisible.
 * Blocking shortages are those lacking physical pallet positions entirely.
 */
export function newlyWorsenedShipmentShortage(
  before: PlanningAvailabilityIssue[],
  after: PlanningAvailabilityIssue[],
): PlanningAvailabilityIssue | undefined {
  const key = (issue: PlanningAvailabilityIssue) =>
    `${issue.week}:${issue.date}:${issue.productId}`;
  const totals = (issues: PlanningAvailabilityIssue[]) => {
    const byKey = new Map<string, number>();
    for (const issue of issues.filter((entry) => entry.severity !== "partial")) {
      const id = key(issue);
      byKey.set(id, (byKey.get(id) ?? 0) + issue.missing);
    }
    return byKey;
  };
  // More than one truck may depart on the same day with the same SKU. The
  // old map overwrote one deficit with another and could miss a NEW shortage.
  const oldTotals = totals(before);
  const newTotals = totals(after);
  return after.find((issue) => issue.severity !== "partial" &&
    (newTotals.get(key(issue)) ?? 0) > (oldTotals.get(key(issue)) ?? 0));
}
