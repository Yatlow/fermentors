import type { DeliveryPlan, Product } from "./planningEngine";
import { groupPlannedShipments } from "./shipmentActuals";

/** Edits affect the selected physical truck only. Stable manifest rows keep
 * their ID and pallet picks when quantity is unchanged. Changed SKUs discard
 * their old picks explicitly so that they can be reselected under FEFO.
 */
export function replaceShipmentTrip(args: {
  deliveries: DeliveryPlan[];
  truckId: string;
  defaultDate: string;
  products: Product[];
  draft: Readonly<Record<string, number>>;
  createId: () => string;
}): DeliveryPlan[] {
  const { deliveries, truckId, defaultDate, products, draft, createId } = args;
  const trip = groupPlannedShipments(deliveries).find((group) => group.id === truckId);
  const dispatchDate = trip?.dispatchDate ?? defaultDate;
  const arrivalDate = trip?.deliveries[0]?.arrivalDate ?? dispatchDate;
  const others = deliveries.filter((delivery) =>
    (delivery.truckId || `date:${delivery.dispatchDate}`) !== truckId);
  const replacements: DeliveryPlan[] = products.flatMap((product) => {
    const quantity = Math.max(0, Number(draft[product.id] ?? 0));
    if (!quantity) return [];
    const previous = trip?.deliveries.find((delivery) => delivery.productId === product.id);
    return [{
      id: previous?.id ?? createId(),
      productId: product.id,
      quantity, dispatchDate, arrivalDate, truckId,
      pallets: previous?.quantity === quantity ? (previous.pallets ?? []) : [],
    }];
  });
  return [...others, ...replacements];
}
