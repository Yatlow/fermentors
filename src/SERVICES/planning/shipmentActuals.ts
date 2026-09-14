import {
  sameStyle,
  weekStart,
  type DeliveryPlan,
  type Product,
  type WeekPlan,
} from "./planningEngine";
import type { ShipmentEvent } from "./dailyPlanner";

export type ShipmentActualTotal = {
  itemType: "crates" | "kegs";
  beerStyle: string;
  totalQuantity: number;
};

export type DetailedShipmentEvent = ShipmentEvent & {
  shipmentNumber?: number;
  totals?: ShipmentActualTotal[];
};

export type PlannedShipmentGroup = {
  id: string;
  dispatchDate: string;
  deliveries: DeliveryPlan[];
};

export type ShipmentMatch = {
  planned: PlannedShipmentGroup;
  actual?: DetailedShipmentEvent;
  score: number | null;
  status: "pending" | "matched" | "actual-different";
};

export function groupPlannedShipments(deliveries: DeliveryPlan[]): PlannedShipmentGroup[] {
  const groups = new Map<string, PlannedShipmentGroup>();
  for (const delivery of deliveries.filter((d) => d.quantity > 0)) {
    const id = delivery.truckId || `date:${delivery.dispatchDate}`;
    const group = groups.get(id) ?? { id, dispatchDate: delivery.dispatchDate, deliveries: [] };
    group.deliveries.push(delivery);
    if (delivery.dispatchDate < group.dispatchDate) group.dispatchDate = delivery.dispatchDate;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.dispatchDate.localeCompare(b.dispatchDate) || a.id.localeCompare(b.id));
}

function plannedQuantity(group: PlannedShipmentGroup, product: Product) {
  return group.deliveries
    .filter((d) => d.productId === product.id)
    .reduce((sum, d) => sum + d.quantity, 0);
}

function actualQuantity(actual: DetailedShipmentEvent, product: Product) {
  return (actual.totals ?? [])
    .filter((line) =>
      line.itemType === product.type &&
      sameStyle(line.beerStyle, product.style),
    )
    .reduce((sum, line) => sum + Number(line.totalQuantity || 0), 0);
}

/** Weighted overlap: 1 is identical, 0 has no SKU/quantity overlap. */
export function shipmentMatchScore(
  group: PlannedShipmentGroup,
  actual: DetailedShipmentEvent,
  products: Product[],
): number | null {
  if (!actual.totals?.length) return null;
  let overlap = 0;
  let union = 0;
  for (const product of products) {
    const planned = plannedQuantity(group, product);
    const sent = actualQuantity(actual, product);
    overlap += Math.min(planned, sent);
    union += Math.max(planned, sent);
  }
  return union > 0 ? overlap / union : null;
}

export function matchActualShipments(
  deliveries: DeliveryPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
  threshold = 0.85,
): ShipmentMatch[] {
  const groups = groupPlannedShipments(deliveries);
  const actuals = actualEvents as DetailedShipmentEvent[];
  const unused = new Set(actuals.map((event) => event.id));

  return groups.map((planned) => {
    const sameWeek = actuals.filter((actual) =>
      unused.has(actual.id) && weekStart(actual.date) === weekStart(planned.dispatchDate),
    );
    if (!sameWeek.length) return { planned, score: null, status: "pending" as const };

    const ranked = sameWeek
      .map((actual) => ({ actual, score: shipmentMatchScore(planned, actual, products) }))
      .sort((a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        Math.abs(Date.parse(`${a.actual.date}T12:00:00Z`) - Date.parse(`${planned.dispatchDate}T12:00:00Z`)) -
          Math.abs(Date.parse(`${b.actual.date}T12:00:00Z`) - Date.parse(`${planned.dispatchDate}T12:00:00Z`)),
      );
    const best = ranked[0];
    if (!best) return { planned, score: null, status: "pending" as const };

    if (best.score === null || best.score >= threshold) {
      unused.delete(best.actual.id);
      return { planned, actual: best.actual, score: best.score, status: "matched" as const };
    }

    // A shipment happened in the planned week, but its SKU mix differs materially.
    // It still closes that trip operationally; the UI flags the mismatch instead of hiding it.
    unused.delete(best.actual.id);
    return { planned, actual: best.actual, score: best.score, status: "actual-different" as const };
  });
}

export function shipmentMatchesForPlans(
  plans: WeekPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
) {
  return plans.flatMap((week) =>
    matchActualShipments(week.deliveries ?? [], actualEvents, products)
      .map((match) => ({ ...match, week: week.id })),
  );
}

/**
 * Planning UI works only with trips that are still operationally open.
 * Completed trips are omitted, but remain in Firestore and can be merged back on save.
 */
export function pendingPlansAfterActualShipments(
  plans: WeekPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
): WeekPlan[] {
  return plans.map((week) => {
    const deliveries = week.deliveries ?? [];
    const matches = matchActualShipments(deliveries, actualEvents, products);
    const pendingGroupIds = new Set(
      matches.filter((match) => match.status === "pending").map((match) => match.planned.id),
    );
    if (!matches.some((match) => match.status !== "pending")) return week;
    return {
      ...week,
      deliveries: deliveries.filter((delivery) =>
        pendingGroupIds.has(delivery.truckId || `date:${delivery.dispatchDate}`),
      ),
      deliveryDates: [...new Set(
        deliveries
          .filter((delivery) => pendingGroupIds.has(delivery.truckId || `date:${delivery.dispatchDate}`))
          .map((delivery) => delivery.dispatchDate),
      )],
    };
  });
}

export function mergeCompletedDeliveriesBack(
  original: WeekPlan,
  pendingEdited: WeekPlan,
  actualEvents: ShipmentEvent[],
  products: Product[],
): WeekPlan {
  const matches = matchActualShipments(original.deliveries ?? [], actualEvents, products);
  const completedGroupIds = new Set(
    matches.filter((match) => match.status !== "pending").map((match) => match.planned.id),
  );
  const completed = (original.deliveries ?? []).filter((delivery) =>
    completedGroupIds.has(delivery.truckId || `date:${delivery.dispatchDate}`),
  );
  const deliveries = [...completed, ...(pendingEdited.deliveries ?? [])];
  return {
    ...pendingEdited,
    deliveries,
    deliveryDates: [...new Set(deliveries.map((delivery) => delivery.dispatchDate))].sort(),
  };
}

export function nextUnfulfilledShipment(
  deliveries: DeliveryPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
) {
  return matchActualShipments(deliveries, actualEvents, products)
    .find((match) => match.status === "pending")?.planned ?? null;
}
