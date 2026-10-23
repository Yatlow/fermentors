import {
  parseDate,
  sameStyle,
  weekStart,
  type DeliveryPlan,
  type Product,
  type Settings,
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

/**
 * Actual shipments are Tempo receipts for planning purposes.  Apply only shipments
 * that happened after the last explicit Tempo snapshot, so a newly entered stock
 * count remains the source of truth and is never double-counted.
 */
export function settingsAfterActualShipments(
  settings: Settings,
  actualEvents: ShipmentEvent[],
  throughDate: string,
): Settings {
  const actuals = actualEvents as DetailedShipmentEvent[];
  return {
    ...settings,
    products: settings.products.map((product) => {
      if (product.tempo === null) return product;
      const tempoDate = parseDate(product.tempoDate);
      const received = actuals
        .filter((shipment) =>
          shipment.date <= throughDate &&
          (!tempoDate || shipment.date > tempoDate),
        )
        .reduce((sum, shipment) => sum + actualQuantity(shipment, product), 0);
      return received > 0 ? { ...product, tempo: product.tempo + received } : product;
    }),
  };
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
  // A manifest containing unknown SKUs is *not* a missing manifest.
  // Treat it as zero overlap rather than allowing a date-only legacy match.
  return union > 0 ? overlap / union : 0;
}

/**
 * Choose the still-open queue trip that an actual shipment closes.
 * Queue rows already use product ids/SKUs, so this version does not depend on a
 * settings snapshot and can run synchronously in the shipment completion flow.
 */
export function completedShipmentQueueTruckId(
  deliveries: DeliveryPlan[],
  actualByProduct: Readonly<Record<string, number>>,
  shipmentDate: string,
): string | null {
  const groups = groupPlannedShipments(deliveries)
    .filter((group) => weekStart(group.dispatchDate) === weekStart(shipmentDate));
  if (!groups.length) return null;

  const actualKeys = Object.keys(actualByProduct);
  const ranked = groups.map((group) => {
    const planned = new Map<string, number>();
    group.deliveries.forEach((delivery) => {
      planned.set(
        delivery.productId,
        (planned.get(delivery.productId) ?? 0) + Number(delivery.quantity || 0),
      );
    });
    const keys = new Set([...planned.keys(), ...actualKeys]);
    let overlap = 0;
    let union = 0;
    keys.forEach((productId) => {
      const expected = planned.get(productId) ?? 0;
      const sent = Number(actualByProduct[productId] ?? 0);
      overlap += Math.min(expected, sent);
      union += Math.max(expected, sent);
    });
    return {
      group,
      score: union > 0 ? overlap / union : null,
      distance: Math.abs(
        Date.parse(`${shipmentDate}T12:00:00Z`) -
        Date.parse(`${group.dispatchDate}T12:00:00Z`),
      ),
    };
  });

  ranked.sort((a, b) =>
    (b.score ?? -1) - (a.score ?? -1) ||
    a.distance - b.distance ||
    a.group.id.localeCompare(b.group.id),
  );
  // A completely unrelated dispatch cannot prove that a planned trip left.
  // Do not close and release its reservations on the basis of date proximity.
  const winner = ranked[0];
  return winner && winner.score != null && winner.score > 0 ? winner.group.id : null;
}

export function matchActualShipments(
  deliveries: DeliveryPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
  threshold = 0.85,
): ShipmentMatch[] {
  const groups = groupPlannedShipments(deliveries);
  const actuals = actualEvents as DetailedShipmentEvent[];
  // Compare ALL trips in an operational week before assigning an actual to
  // one of them. Matching in declaration order could steal truck B's manifest
  // for truck A, then incorrectly mark B pending.
  const candidates = groups.flatMap((planned) =>
    actuals.filter((actual) => weekStart(actual.date) === weekStart(planned.dispatchDate))
      .map((actual) => ({
        planned, actual, score: shipmentMatchScore(planned, actual, products),
        distance: Math.abs(Date.parse(`${actual.date}T12:00:00Z`) -
          Date.parse(`${planned.dispatchDate}T12:00:00Z`)),
      }))
      .filter((candidate) => {
        if (candidate.score !== null) return candidate.score > 0;
        // Older reports without a manifest have no SKU match signal. Accept
        // only the unambiguous same-day one-trip / one-report case.
        return candidate.distance === 0 &&
          groups.filter((group) => group.dispatchDate === candidate.actual.date).length === 1 &&
          actuals.filter((event) => event.date === candidate.actual.date).length === 1;
      }),
  ).sort((a, b) =>
    (b.score ?? -1) - (a.score ?? -1) ||
    a.distance - b.distance ||
    a.planned.id.localeCompare(b.planned.id) ||
    a.actual.id.localeCompare(b.actual.id),
  );
  const matched = new Map<string, ShipmentMatch>();
  const usedActuals = new Set<string>();
  for (const { planned, actual, score } of candidates) {
    if (matched.has(planned.id) || usedActuals.has(actual.id)) continue;
    matched.set(planned.id, {
      planned, actual, score,
      status: score === null || score >= threshold ? "matched" : "actual-different",
    });
    usedActuals.add(actual.id);
  }
  return groups.map((planned) =>
    matched.get(planned.id) ?? { planned, score: null, status: "pending" });
}

export function pendingDeliveriesForReservationQueue(
  deliveries: DeliveryPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
): DeliveryPlan[] {
  const pendingGroupIds = new Set(
    matchActualShipments(deliveries, actualEvents, products)
      .filter((match) => match.status === "pending")
      .map((match) => match.planned.id),
  );
  return deliveries.filter((delivery) =>
    delivery.quantity > 0 &&
    pendingGroupIds.has(delivery.truckId || `date:${delivery.dispatchDate}`)
  );
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
  // Weekly editors can send the full original plan, including completed rows.
  // Keep immutable completed trips exactly once; only append still-open edits.
  const pending = (pendingEdited.deliveries ?? []).filter((delivery) =>
    !completedGroupIds.has(delivery.truckId || `date:${delivery.dispatchDate}`));
  const deliveries = [...completed, ...pending];
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
