import type { DeliveryPlan } from "./planningEngine";

/** Immutable real-world trip identity exists only when the shipping operator
 * explicitly chose a scheduled departure or an auto-reserved truck was verified.
 */
export type PlannedDispatchTrip = {
  id: string; date: string; manifest: Array<{ productId: string; quantity: number }>;
};

export function plannedTripsForDispatchDay(
  deliveries: DeliveryPlan[], today: string,
): PlannedDispatchTrip[] {
  const groups = new Map<string, PlannedDispatchTrip>();
  for (const delivery of deliveries) {
    if (delivery.dispatchDate !== today || delivery.quantity <= 0) continue;
    const id = String(delivery.truckId || `date:${delivery.dispatchDate}`);
    const existing = groups.get(id) ?? { id, date: today, manifest: [] };
    const row = existing.manifest.find((item) => item.productId === delivery.productId);
    if (row) row.quantity += delivery.quantity;
    else existing.manifest.push({
      productId: delivery.productId, quantity: delivery.quantity,
    });
    groups.set(id, existing);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function isDispatchTripInQueue(
  queue: { projectionVersion?: number; deliveries?: DeliveryPlan[] } | undefined,
  today: string, truckId: string,
): boolean {
  return queue?.projectionVersion === 1 &&
    plannedTripsForDispatchDay(queue.deliveries ?? [], today)
      .some((trip) => trip.id === truckId);
}
