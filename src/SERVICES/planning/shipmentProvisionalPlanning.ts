import { openRuns } from "./dailyPlanner";
import type { Actual, Product, WeekPlan } from "./planningEngine";
import type { PlanningShortageIncrease } from "./shipmentAvailabilityAudit";

/**
 * A saved weekly packaging decision without a date is a planning intention,
 * NOT physical inventory. It may back a provisional shipment for the same
 * week after explicit acknowledgement, but never fulfil physical picking.
 *
 * Use outstanding (not original) planned units, so a completed packaging
 * report cannot be credited a second time.
 */
export function sameWeekUnscheduledPackagingUnits(
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  weekId: string,
  productId: string,
): number {
  return openRuns(plans, products, actuals)
    .filter((run) =>
      run.week === weekId &&
      run.productId === productId &&
      !run.date &&
      run.remaining > 0)
    .reduce((sum, run) => sum + run.remaining, 0);
}

/**
 * Keep the normal same-week shipment shortage block unless there is enough
 * uncompleted, undated packaging in the edited week to back the entire
 * outstanding shortage for that SKU. Never waive pinned-pallet or truck
 * integrity errors; those must always remain hard blocking issues.
 *
 * Group all dates/trucks for each SKU before comparing units so one packaging
 * decision cannot justify two independent shipments.
 */
export function confirmableUnpackedShipmentShortages(
  increases: readonly PlanningShortageIncrease[],
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  editedWeekId: string,
): PlanningShortageIncrease[] {
  const candidates = increases.filter(({ issue }) =>
    issue.week === editedWeekId &&
    products.some((product) => product.id === issue.productId));
  const missingBySku = new Map<string, number>();
  for (const { issue, totalUnits } of candidates) {
    missingBySku.set(issue.productId,
      (missingBySku.get(issue.productId) ?? 0) + Math.max(0, totalUnits));
  }

  const backed = new Set<string>();
  for (const [productId, missingUnits] of missingBySku) {
    if (missingUnits <= 0) continue;
    const outstanding = sameWeekUnscheduledPackagingUnits(
      plans, products, actuals, editedWeekId, productId);
    if (outstanding + 1e-6 >= missingUnits) backed.add(productId);
  }
  return candidates.filter(({ issue }) => backed.has(issue.productId));
}
