import { doc, getDocFromServer } from "firebase/firestore";
import { db } from "../../firebase";
import { dateKey, weekStart, type DeliveryPlan } from "./planningEngine";
import { plannedTripsForDispatchDay, type PlannedDispatchTrip } from "./shipmentDispatchIdentityCore";
export { plannedTripsForDispatchDay, isDispatchTripInQueue } from "./shipmentDispatchIdentityCore";
export type { PlannedDispatchTrip } from "./shipmentDispatchIdentityCore";

/** LoadingDock users can read this operational projection without planner
 * permissions, then choose the real physical trip explicitly.
 */
export async function loadPlannedDispatchTrips(
  today: string = dateKey(new Date()),
): Promise<PlannedDispatchTrip[]> {
  const snap = await getDocFromServer(doc(db, "shipmentPlanningQueue", weekStart(today)));
  const data = snap.data();
  if (!snap.exists() || data?.projectionVersion !== 1 ||
      !Array.isArray(data.deliveries)) return [];
  return plannedTripsForDispatchDay(data.deliveries as DeliveryPlan[], today);
}
