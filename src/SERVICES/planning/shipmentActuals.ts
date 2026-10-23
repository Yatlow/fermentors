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
  /** Direct physical link when the shipment was dispatched from one auto-reserved truck. */
  plannedTruckId?: string;
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

function actualQuantity(actual: DetailedShipmentEvent, product: Product) {
  return (actual.totals ?? [])
    .filter((line) =>
      line.itemType === product.type &&
      sameStyle(line.beerStyle, product.style),
    )
    .reduce((sum, line) => sum + Number(line.totalQuantity || 0), 0);
}

/** The same SKU + quantity overlap is used in the UI and in the operational
 * reservation queue. Unexpected SKUs count against match confidence.
 */
export function shipmentManifestScore(
  expected: Readonly<Record<string, number>>,
  sent: Readonly<Record<string, number>>,
): number | null {
  const ids = new Set([...Object.keys(expected), ...Object.keys(sent)]);
  let overlap = 0;
  let union = 0;
  for (const id of ids) {
    const planned = Number(expected[id] ?? 0);
    const actual = Number(sent[id] ?? 0);
    if (!Number.isFinite(planned) || !Number.isFinite(actual) ||
        planned < 0 || actual < 0) return null;
    overlap += Math.min(planned, actual);
    union += Math.max(planned, actual);
  }
  return union > 0 ? overlap / union : null;
}

function plannedManifest(group: PlannedShipmentGroup): Record<string, number> {
  const expected: Record<string, number> = {};
  for (const line of group.deliveries) {
    expected[line.productId] = (expected[line.productId] ?? 0) + line.quantity;
  }
  return expected;
}

function actualManifest(
  actual: DetailedShipmentEvent,
  products: Product[],
): Record<string, number> | null {
  if (!actual.totals?.length) return null;
  const sent: Record<string, number> = {};
  for (const line of actual.totals) {
    const candidates = products.filter((p) =>
      p.type === line.itemType && sameStyle(p.style, line.beerStyle));
    // Never infer a SKU from a style if the catalog contains two candidates.
    const id = candidates.length === 1 ? candidates[0].id :
      `__unmapped__:${line.itemType}:${line.beerStyle}`;
    sent[id] = (sent[id] ?? 0) + Number(line.totalQuantity || 0);
  }
  return sent;
}

function distinctManifestsConflict(
  winner: { manifest: string; score: number | null },
  ranked: Array<{ manifest: string; score: number | null }>,
): boolean {
  return ranked.some((candidate) =>
    candidate.score !== null && winner.score !== null &&
    Math.abs(candidate.score - winner.score) < 1e-9 &&
    candidate.manifest !== winner.manifest);
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
  const sent = actualManifest(actual, products);
  return sent ? shipmentManifestScore(plannedManifest(group), sent) : null;
}

/**
 * Choose the still-open queue trip that an actual shipment closes.
 * Queue rows already use product ids/SKUs, so this version does not depend on a
 * settings snapshot and can run synchronously in the shipment completion flow.
 */
export const MIN_TRIP_MATCH_CONFIDENCE = 0.85;

/** Only unambiguously high-overlap reports can close an unlinked queue trip.
 * A direct immutable trip reference takes precedence over heuristic scoring.
 */
export function completedShipmentQueueTruckId(
  deliveries: DeliveryPlan[],
  actualByProduct: Readonly<Record<string, number>>,
  shipmentDate: string,
  explicitTruckId?: string | null,
): string | null {
  const groups = groupPlannedShipments(deliveries)
    .filter((group) => weekStart(group.dispatchDate) === weekStart(shipmentDate));
  if (!groups.length) return null;
  if (explicitTruckId) {
    return groups.some((group) => group.id === explicitTruckId) ? explicitTruckId : null;
  }

  const ranked = groups.map((group) => {
    const manifest = plannedManifest(group);
    return {
      group,
      manifest: JSON.stringify(Object.entries(manifest)
        .sort(([a], [b]) => a.localeCompare(b))),
      score: shipmentManifestScore(manifest, actualByProduct),
      distance: Math.abs(
        Date.parse(`${shipmentDate}T12:00:00Z`) -
        Date.parse(`${group.dispatchDate}T12:00:00Z`),
      ),
    };
  }).sort((a, b) =>
    (b.score ?? -1) - (a.score ?? -1) ||
    a.distance - b.distance ||
    a.group.id.localeCompare(b.group.id),
  );
  const winner = ranked[0];
  if (!winner || winner.score === null ||
      winner.score < MIN_TRIP_MATCH_CONFIDENCE) return null;
  // A tied high-score *different manifest* is ambiguous. Identical manifests
  // are exchangeable for stock planning, so keep the deterministic first trip.
  if (distinctManifestsConflict(winner, ranked)) return null;
  return winner.group.id;
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
  // Physically linked reports always win over heuristic candidates, even
  // when their manifest differs. Unlinked reports must meet the SAME 85%
  // threshold as the operational reservation queue. A date-only legacy
  // report is surfaced as unmatched, never silently used to release stock.
  const candidates = groups.flatMap((planned) =>
    actuals.filter((actual) => weekStart(actual.date) === weekStart(planned.dispatchDate))
      .map((actual) => ({
        planned, actual, score: shipmentMatchScore(planned, actual, products),
        direct: actual.plannedTruckId === planned.id,
        manifest: JSON.stringify(Object.entries(plannedManifest(planned))
          .sort(([a], [b]) => a.localeCompare(b))),
        distance: Math.abs(Date.parse(`${actual.date}T12:00:00Z`) -
          Date.parse(`${planned.dispatchDate}T12:00:00Z`)),
      }))
      .filter((candidate) => candidate.actual.plannedTruckId
        ? candidate.direct
        : candidate.score !== null && candidate.score >= threshold),
  ).sort((a, b) =>
    Number(b.direct) - Number(a.direct) ||
    (b.score ?? -1) - (a.score ?? -1) ||
    a.distance - b.distance ||
    a.planned.id.localeCompare(b.planned.id) ||
    a.actual.id.localeCompare(b.actual.id),
  );
  const matched = new Map<string, ShipmentMatch>();
  const usedActuals = new Set<string>();
  for (const { planned, actual, score } of candidates) {
    if (matched.has(planned.id) || usedActuals.has(actual.id)) continue;
    if (!actual.plannedTruckId &&
        distinctManifestsConflict(
          { manifest: JSON.stringify(Object.entries(plannedManifest(planned))
            .sort(([a], [b]) => a.localeCompare(b))), score },
          candidates.filter((candidate) => candidate.actual.id === actual.id),
        )) continue;
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
