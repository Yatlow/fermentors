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
import { tempoInventoryBaselineAt } from "./tempoInventoryTimeline";

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

/** Canonical receipt manifest, shared between planner UI and operational queue.
 * Unknown catalog lines MUST be retained, not dropped: otherwise an unrelated
 * shipment can appear to match 100% and close the wrong planned truck.
 */
export function shipmentActualManifestFromTotals(
  totals: ShipmentActualTotal[],
  resolveProductId: (style: string, type: "crates" | "kegs") => string | null,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of totals) {
    if (line.itemType !== "crates" && line.itemType !== "kegs") continue;
    const quantity = Number(line.totalQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const style = String(line.beerStyle ?? "").trim();
    const productId = resolveProductId(style, line.itemType) ||
      `__unmapped__:${line.itemType}:${style.toLowerCase()}`;
    result[productId] = (result[productId] ?? 0) + quantity;
  }
  return result;
}

function actualManifest(
  actual: DetailedShipmentEvent,
  products: Product[],
): Record<string, number> | null {
  if (!actual.totals?.length) return null;
  return shipmentActualManifestFromTotals(actual.totals, (style, kind) => {
    const candidates = products.filter((p) =>
      p.type === kind && sameStyle(p.style, style));
    // Two catalog entries for the same style are ambiguous, not interchangeable.
    return candidates.length === 1 ? candidates[0].id : null;
  });
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
    products: settings.products.map((product) =>
      tempoInventoryBaselineAt(product, throughDate,
        actuals.map((shipment) => ({
          date: shipment.date,
          occurredAt: shipment.occurredAt,
          quantity: actualQuantity(shipment, product),
        }))),
    ),
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
/** Normalized actual shipment, with a catalog-aware product quantity manifest. */
export type ShipmentManifestEvent = ShipmentEvent & {
  plannedTruckId?: string;
  manifest: Readonly<Record<string, number>> | null;
};
export type ShipmentManifestMatch = {
  planned: PlannedShipmentGroup;
  actual?: ShipmentManifestEvent;
  score: number | null;
  status: "pending" | "matched" | "actual-different";
};

/**
 * The single matching engine for UI, audit, pending decisions and the
 * operational pallet reservation queue. One actual can close at most one
 * planned trip; a direct persisted trip ID takes priority. Unlinked records
 * need strong, unambiguous SKU/quantity overlap. No date-only matching.
 */
export function matchShipmentManifests(
  deliveries: DeliveryPlan[],
  actuals: ShipmentManifestEvent[],
  threshold = MIN_TRIP_MATCH_CONFIDENCE,
): ShipmentManifestMatch[] {
  const groups = groupPlannedShipments(deliveries);
  const candidates = groups.flatMap((planned) =>
    actuals.filter((actual) =>
      weekStart(actual.date) === weekStart(planned.dispatchDate))
      .map((actual) => ({
        planned, actual,
        score: actual.manifest
          ? shipmentManifestScore(plannedManifest(planned), actual.manifest)
          : null,
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
  const matched = new Map<string, ShipmentManifestMatch>();
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
      // Confidence >=85% identifies WHICH trip departed; only 100% SKU and
      // quantity parity establishes that it departed AS PLANNED. A directly
      // linked shipment with a changed load is completed but not identical.
      status: score !== null && Math.abs(score - 1) < 1e-9
        ? "matched" : "actual-different",
    });
    usedActuals.add(actual.id);
  }
  return groups.map((planned) =>
    matched.get(planned.id) ?? { planned, score: null, status: "pending" });
}

/** Compatibility adapter for a one-receipt queue check. */
export function completedShipmentQueueTruckId(
  deliveries: DeliveryPlan[],
  actualByProduct: Readonly<Record<string, number>>,
  shipmentDate: string,
  explicitTruckId?: string | null,
): string | null {
  return matchShipmentManifests(deliveries, [{
    id: "one-receipt", date: shipmentDate,
    plannedTruckId: explicitTruckId ?? undefined,
    manifest: actualByProduct,
  }]).find((match) => match.status !== "pending")?.planned.id ?? null;
}

/**
 * A physical Tempo departure with no confident trip link means the truck may
 * already be gone. Never repick new pallets for another still-open trip on
 * that same dispatch date until the operator reconciles the shipment.
 */
export function hasUnmatchedPhysicalDepartureForToday(
  matches: ShipmentManifestMatch[],
  actuals: ShipmentManifestEvent[],
  today: string,
): boolean {
  const attached = new Set(matches.flatMap((match) =>
    match.actual?.id ? [match.actual.id] : []));
  const pendingDays = new Set(matches
    .filter((match) => match.status === "pending")
    .map((match) => match.planned.dispatchDate));
  return actuals.some((actual) =>
    !attached.has(actual.id) &&
    actual.date <= today && pendingDays.has(actual.date));
}

export function matchActualShipments(
  deliveries: DeliveryPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
  threshold = MIN_TRIP_MATCH_CONFIDENCE,
): ShipmentMatch[] {
  const detailed = actualEvents as DetailedShipmentEvent[];
  const events: ShipmentManifestEvent[] = detailed.map((actual) => ({
    id: actual.id,
    date: actual.date,
    plannedTruckId: actual.plannedTruckId,
    manifest: actualManifest(actual, products),
  }));
  const byId = new Map(detailed.map((event) => [event.id, event]));
  return matchShipmentManifests(deliveries, events, threshold).map((match) => ({
    planned: match.planned,
    actual: match.actual ? byId.get(match.actual.id) : undefined,
    score: match.score,
    status: match.status,
  }));
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

/**
 * Execution statuses must remain visible until an unlinked physical shipment
 * is reconciled; however forecasts MUST NOT silently schedule a second
 * shipment against stock that may already have left in that same physical
 * departure. Conservatively quarantine only pending trips on the unresolved
 * actual's dispatch date from the *forecast*, without marking them completed
 * or altering persisted decisions. The shipment status portal still warns.
 */
export function forecastablePlansAfterActualShipments(
  plans: WeekPlan[],
  actualEvents: ShipmentEvent[],
  products: Product[],
  today: string,
): WeekPlan[] {
  const pending = pendingPlansAfterActualShipments(plans, actualEvents, products);
  return pending.map((week) => {
    const matches = matchActualShipments(week.deliveries ?? [], actualEvents, products);
    const linkedActualIds = new Set(matches.flatMap((match) =>
      match.actual?.id ? [match.actual.id] : []));
    const unlinkedSameWeekDates = new Set(actualEvents
      .filter((actual) =>
        actual.date <= today &&
        weekStart(actual.date) === week.id &&
        !linkedActualIds.has(actual.id))
      .map((actual) => actual.date));
    if (!unlinkedSameWeekDates.size) return week;
    const remaining = (week.deliveries ?? []).filter((delivery) =>
      !unlinkedSameWeekDates.has(delivery.dispatchDate));
    if (remaining.length === (week.deliveries ?? []).length) return week;
    return {
      ...week, deliveries: remaining,
      deliveryDates: [...new Set(remaining.map((d) => d.dispatchDate))].sort(),
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
