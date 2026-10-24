import { type Actual, type Product, type WeekPlan } from "./planningEngine";
import { type ShipmentEvent } from "./dailyPlanner";
import { pendingPlansAfterActualShipments } from "./shipmentActuals";
import { pendingPackagingDecisions, type PackagingSource } from "./packagingActuals";

/** Stock overview lists outstanding execution tasks, NEVER raw committed
 * rows already fulfilled by physical packaging reports or Tempo departures.
 * This is a shared pure model to keep the UI consistent with the Gantt/board.
 */
export function pendingStockExecutionPlans(
  plans: WeekPlan[],
  products: Product[],
  packagingReports: Actual[],
  actualShipments: ShipmentEvent[],
  sources: PackagingSource[],
): WeekPlan[] {
  return pendingPlansAfterActualShipments(plans, actualShipments, products)
    .map((week) => ({
      ...week,
      packaging: pendingPackagingDecisions(week, products, packagingReports, sources),
    }));
}
