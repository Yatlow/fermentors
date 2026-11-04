import { openRuns } from "./dailyPlanner";
import { weekStart, type Actual, type Product, type WeekPlan } from "./planningEngine";
import type { PlanningAvailabilityIssue, PlanningShortageIncrease } from "./shipmentAvailabilityAudit";

/**
 * Unscheduled packaging is planning intent, NEVER physical inventory.
 * Include outstanding decisions from the current operational week through
 * the selected shipment week. Earlier completed weeks with no actual
 * packaging are stale and cannot be reused as new stock.
 */
export function unscheduledPackagingBeforeShipment(
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  today: string,
  shipmentWeek: string,
  productId: string,
): number {
  const currentWeek = weekStart(today);
  return openRuns(plans, products, actuals)
    .filter((run) => run.week >= currentWeek && run.week <= shipmentWeek &&
      run.productId === productId && !run.date && run.remaining > 0)
    .reduce((sum, run) => sum + run.remaining, 0);
}

/** Keep the original same-week operation available to existing callers/tests. */
export function sameWeekUnscheduledPackagingUnits(
  plans: WeekPlan[], products: Product[], actuals: Actual[],
  weekId: string, productId: string,
): number {
  return openRuns(plans, products, actuals)
    .filter((run) => run.week === weekId && run.productId === productId &&
      !run.date && run.remaining > 0)
    .reduce((sum, run) => sum + run.remaining, 0);
}

/**
 * Earlier *physical* stock is already represented in the week-start
 * projection, including earlier dispatches. Deduct only prior deficits
 * that had to rely on an undated packaging promise, not every delivery.
 */
export function previousUncoveredShipmentUnits(
  issues: readonly PlanningAvailabilityIssue[],
  productId: string,
  today: string,
  shipmentWeek: string,
): number {
  const currentWeek = weekStart(today);
  return issues
    .filter((issue) => issue.productId === productId &&
      issue.week >= currentWeek && issue.week < shipmentWeek &&
      issue.severity !== "advisory")
    .reduce((sum, issue) => sum + Math.max(0, Number(issue.missingUnits) || 0), 0);
}

/**
 * A new shortage may be acknowledged as provisional when outstanding, undated
 * packaging from the CURRENT or an intervening week can cover it by dispatch.
 * Check cumulative chronological shortages, including previously saved trips,
 * so no older promise can be reused for a second shipment.
 *
 * Leave pinned-pallet and truck structural errors blocking. Never mutate
 * forecast stock or count undated packaging as a physically picked pallet.
 */
export function confirmableUnpackedShipmentShortages(
  increases: readonly PlanningShortageIncrease[],
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  editedWeekId: string,
  today: string = editedWeekId,
  allShortages: readonly PlanningAvailabilityIssue[] = [],
): PlanningShortageIncrease[] {
  const productIds = new Set(products.map((product) => product.id));
  const candidates = increases.filter(({ issue }) =>
    issue.week === editedWeekId && productIds.has(issue.productId));

  // Backwards-compatible fallback for callers that only have the delta.
  const shortageRows: Array<PlanningAvailabilityIssue> = allShortages.length
    ? [...allShortages]
    : increases.map(({ issue, totalUnits }) => ({
        ...issue, missingUnits: Math.max(0, totalUnits),
      }));

  const backed = new Set<string>();
  const currentWeek = weekStart(today);
  for (const productId of new Set(candidates.map(({ issue }) => issue.productId))) {
    const relevant = shortageRows.filter((issue) =>
      issue.productId === productId && issue.week >= currentWeek &&
      issue.week <= editedWeekId && issue.severity !== "advisory");
    const weeks = [...new Set([...relevant.map((issue) => issue.week), editedWeekId])].sort();
    if (!relevant.length) continue;
    const everyPrefixCovered = weeks.every((shipmentWeek) => {
      const missing = relevant
        .filter((issue) => issue.week <= shipmentWeek)
        .reduce((sum, issue) => sum + Math.max(0, Number(issue.missingUnits) || 0), 0);
      return unscheduledPackagingBeforeShipment(
        plans, products, actuals, today, shipmentWeek, productId,
      ) + 1e-6 >= missing;
    });
    if (everyPrefixCovered) backed.add(productId);
  }
  return candidates.filter(({ issue }) => backed.has(issue.productId));
}
