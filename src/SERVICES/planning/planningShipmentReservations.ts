import {
  collection,
  doc,
  getDocsFromServer,
  getDocFromServer,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { getCatalogEntry } from "../cooler/PalletCatalog";
import type { Pallet, PalletZone } from "../cooler/Pallettypes ";
import {
  addDays,
  dateKey,
  sameStyle,
  weekStart,
  type DeliveryPlan,
  type WeekPlan,
} from "./planningEngine";
import { matchShipmentManifests, shipmentActualManifestFromTotals } from "./shipmentActuals";
import { automaticReservationDelta } from "./automaticReservationReconciliation";
import { nextShipmentMarkingRevision, readShipmentMarkingRevision,
  shipmentMarkingGuardRef, shipmentMarkingGuardWrite } from "./shipmentMarkingGuard";
import { expiryIso, palletQuantity } from "./shipmentPicking";
import { shipmentDecisionPickOptions } from "./shipmentDecisionPicking";
import { autoReservationWeek, isDispatchInReservationWeek } from "./shipmentReservationWeek";

const PICKABLE_ZONES: PalletZone[] = ["cooler", "pending", "bottleRoom"];

function activeReservationWeek(today: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23",
  }).format(new Date()));
  return autoReservationWeek(today, hour);
}

export function isPlanningShipmentPickZone(zone: PalletZone): boolean {
  return PICKABLE_ZONES.includes(zone);
}

function skuForPallet(pallet: Pick<Pallet, "beerStyle" | "itemType">): string | null {
  return getCatalogEntry(pallet.beerStyle, pallet.itemType)?.sku ?? null;
}

function palletSize(itemType: Pallet["itemType"]): number {
  return itemType === "crates" ? 84 : 20;
}

type PlannedLine = {
  productId: string;
  quantity: number;
  dispatchDate: string;
  truckId: string;
};

type ActualQueueShipment = {
  id: string;
  date: string;
  plannedTruckId?: string;
  actualByProduct: Record<string, number>;
};

export type ShipmentReservationSyncResult = {
  dispatchDate: string | null;
  markedIds: string[];
  diagnostics: Array<{
    productId: string;
    plannedQuantity: number;
    markedPhysicalQuantity: number;
    markedNominalQuantity: number;
    missingBefore: number;
    selectedIds: string[];
    missingAfter: number;
    candidateCount: number;
    newCandidateCount: number;
  }>;
};

function isTempoShipment(data: Record<string, unknown>): boolean {
  const customerId = typeof data.customerId === "string" ? data.customerId.trim().toLowerCase() : "";
  if (customerId) return customerId === "tempo";
  return /טמפו|tempo/i.test(String(data.customerName ?? "").trim());
}

function shipmentProducts(data: Record<string, unknown>): Record<string, number> {
  const totals = Array.isArray(data.totals)
    ? data.totals.filter((line) => !!line && typeof line === "object")
    : [];
  return shipmentActualManifestFromTotals(
    totals as {beerStyle: string; itemType: "crates" | "kegs"; totalQuantity: number}[],
    (style, itemType) => getCatalogEntry(style, itemType)?.sku ?? null,
  );
}

async function actualTempoShipmentsThisWeek(today: string): Promise<ActualQueueShipment[]> {
  const currentWeek = weekStart(today);
  // Query one extra UTC day so Jerusalem midnight/DST can never exclude an
  // early-Sunday shipment. We filter back to the exact operational week below.
  const queryStart = Timestamp.fromDate(
    new Date(`${addDays(currentWeek, -1)}T00:00:00Z`),
  );
  // Avoid scanning every historical/future shipment each time a pallet is
  // created. The Jerusalem week is contained in this bounded UTC window.
  const queryEnd = Timestamp.fromDate(
    new Date(`${addDays(currentWeek, 8)}T00:00:00Z`),
  );
  const snapshot = await getDocsFromServer(
    query(collection(db, "shipments"),
      where("createdAt", ">=", queryStart),
      where("createdAt", "<", queryEnd)),
  );

  return snapshot.docs.flatMap((item) => {
    const data = item.data() as Record<string, unknown>;
    if (!isTempoShipment(data)) return [];
    const createdAt = data.createdAt as { toDate?: () => Date } | undefined;
    const created = createdAt?.toDate?.();
    if (!created || !Number.isFinite(created.getTime())) return [];
    const date = dateKey(created);
    if (weekStart(date) !== currentWeek) return [];
    return [{ id: item.id, date,
      plannedTruckId: typeof data.plannedTruckId === "string" ? data.plannedTruckId : undefined,
      actualByProduct: shipmentProducts(data) }];
  });
}

/**
 * The saved weekly delivery decision is the reservation source of truth, but the
 * queue is only a projection. Actual shipments are checked on every reservation
 * pass so a stale queue can never re-reserve stock for a truck that already left.
 */
async function nearestPlannedDelivery(today: string): Promise<PlannedLine[]> {
  // Operational packaging users are approved brewery users, but they are not
  // necessarily planners. Read the restricted shipment projection instead of
  // the full planningWeeks documents (same pattern as brewPlanningQueue).
  const [snapshot, actualShipments] = await Promise.all([
    getDocFromServer(doc(db, "shipmentPlanningQueue", activeReservationWeek(today))),
    actualTempoShipmentsThisWeek(today),
  ]);

  const queue = snapshot.exists()
    ? snapshot.data() as WeekPlan & { projectionVersion?: number }
    : null;
  // Only current queue projections are operationally authoritative.
  let openDeliveries: DeliveryPlan[] = queue?.projectionVersion === 1
    ? (queue.deliveries ?? []).filter((delivery) => delivery.quantity > 0)
    : [];

  // Exactly the same one-to-one matching as the planning UI. In particular,
  // unrecognized SKUs are included in manifest confidence, and two physical
  // receipts cannot accidentally close the same truck.
  const matches = matchShipmentManifests(openDeliveries, actualShipments.map((event) => ({
    id: event.id, date: event.date, plannedTruckId: event.plannedTruckId,
    manifest: event.actualByProduct,
  })));
  const pendingTruckIds = new Set(matches
    .filter((match) => match.status === "pending")
    .map((match) => match.planned.id));
  openDeliveries = openDeliveries.filter((delivery) =>
    pendingTruckIds.has(String(delivery.truckId || `date:${delivery.dispatchDate}`)),
  );

  const lines = openDeliveries
    .filter((delivery) => isDispatchEligibleForAutomaticReservation(delivery.dispatchDate, today))
    .map((delivery) => ({
      productId: delivery.productId,
      quantity: delivery.quantity,
      dispatchDate: delivery.dispatchDate,
      truckId: String(delivery.truckId || `date:${delivery.dispatchDate}`),
    }));

  const nearest = [...lines].sort((a, b) =>
    a.dispatchDate.localeCompare(b.dispatchDate) || a.truckId.localeCompare(b.truckId)
  )[0];
  if (!nearest) return [];

  const totals = new Map<string, PlannedLine>();
  for (const line of lines.filter((item) => item.truckId === nearest.truckId)) {
    const previous = totals.get(line.productId);
    totals.set(line.productId, {
      productId: line.productId,
      dispatchDate: line.dispatchDate,
      truckId: line.truckId,
      quantity: (previous?.quantity ?? 0) + line.quantity,
    });
  }
  return [...totals.values()];
}

/** A future-week decision must never reserve current-week inventory. */
export function isDispatchEligibleForAutomaticReservation(dispatchDate: string, today: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  return isDispatchInReservationWeek(dispatchDate, today, hour);
}

function pickForMissing(candidates: Pallet[], missing: number): Pallet[] {
  if (!candidates.length || missing <= 0) return [];
  const itemType = candidates[0].itemType;
  const options = shipmentDecisionPickOptions(candidates, missing, palletSize(itemType));
  const best = options.sort((a, b) =>
    a.missingNominal - b.missingNominal ||
    a.fefoScore - b.fefoScore ||
    a.slots - b.slots ||
    a.overage - b.overage,
  )[0];
  return best?.selected ?? [];
}

/**
 * Reserve stock for the nearest planned shipment.
 *
 * A new-pallet event (packaging or manual pallet creation) triggers the
 * re-evaluation, but it does NOT give the new pallet priority. Selection always
 * runs across the complete eligible stock pool using the normal FEFO/access
 * picker, so an older-expiry pallet is never displaced just because a newer
 * pallet was created now.
 *
 * Shipment decisions are pallet-slot decisions. A partial physical pallet
 * therefore covers one nominal pallet slot, matching shipmentDecisionPickOptions.
 */
export async function reserveNewPalletsForNearestShipment(
  newPalletIds: string[] = [],
): Promise<ShipmentReservationSyncResult> {
  const today = dateKey(new Date());
  const observedMarkingRevision = await readShipmentMarkingRevision();
  const planned = await nearestPlannedDelivery(today);
  const dispatchDate = planned[0]?.dispatchDate ?? null;
  // Picking must evaluate the stock at the promised dispatch date, not when
  // someone taps "sync" several days earlier.
  const expiryCutoff = dispatchDate ?? today;
  const diagnostics: ShipmentReservationSyncResult["diagnostics"] = [];
  // Only operational zones can supply or hold a shipment reservation.
  // Historical shipped pallets are retained for traceability elsewhere, not
  // charged to every 5-minute planning synchronization.
  const palletSnapshot = await getDocsFromServer(query(
    collection(db, "pallets"),
    where("zone", "in", ["cooler", "pending", "bottleRoom", "loadingDock"]),
  ));
  const pallets = palletSnapshot.docs.map(
    (snapshot) => ({ id: snapshot.id, ...snapshot.data() }) as Pallet,
  );
  const currentWeek = activeReservationWeek(today);
  const activeTruckId = planned[0]?.truckId ?? null;
  // The correct set of automatic reservations is recalculated on every pass.
  // An edited smaller trip can release excess auto-marked pallets. Manual
  // marks are never released or converted into automatic reservations.
  const priorAuto = pallets.filter((pallet) =>
    pallet.markedForShipment && !!pallet.autoReservationWeek);
  const priorAutoIds = new Set(priorAuto.map((pallet) => pallet.id));
  const effectivePallets = pallets.map((pallet) => priorAutoIds.has(pallet.id)
    ? { ...pallet, markedForShipment: false } : pallet);
  const newIds = new Set(newPalletIds);
  const idsToMark = new Set<string>();

  for (const line of planned) {
    const matching = effectivePallets.filter((pallet) =>
      pallet.zone !== "shipped" &&
      palletQuantity(pallet) > 0 &&
      skuForPallet(pallet) === line.productId &&
      !!expiryIso(pallet.expiryDateStr) &&
      expiryIso(pallet.expiryDateStr)! >= expiryCutoff,
    );

    const alreadyMarked = matching.filter((pallet) => pallet.markedForShipment);
    const itemType = matching[0]?.itemType;
    const unitPerPallet = itemType ? palletSize(itemType) : 0;
    const markedPhysicalQuantity = alreadyMarked.reduce(
      (sum, pallet) => sum + palletQuantity(pallet), 0);
    const markedNominalQuantity = unitPerPallet > 0
      ? Math.min(line.quantity, alreadyMarked.length * unitPerPallet)
      : markedPhysicalQuantity;
    const missingBefore = Math.max(0, line.quantity - markedNominalQuantity);

    const candidates = matching.filter((pallet) =>
      !pallet.markedForShipment &&
      isPlanningShipmentPickZone(pallet.zone) &&
      !!expiryIso(pallet.expiryDateStr) &&
      expiryIso(pallet.expiryDateStr)! >= expiryCutoff,
    );

    const selected = pickForMissing(candidates, missingBefore);
    const selectedNominal = selected.length > 0
      ? selected.length * palletSize(selected[0].itemType) : 0;
    const missingAfter = Math.max(0, missingBefore - selectedNominal);

    selected.forEach((pallet) => idsToMark.add(pallet.id));
    diagnostics.push({
      productId: line.productId,
      plannedQuantity: line.quantity,
      markedPhysicalQuantity,
      markedNominalQuantity,
      missingBefore,
      selectedIds: selected.map((pallet) => pallet.id),
      missingAfter,
      candidateCount: candidates.length,
      newCandidateCount: candidates.filter((pallet) => newIds.has(pallet.id)).length,
    });
  }

  const { releaseIds: staleAutoIds, assignIds, originalAuto } =
    automaticReservationDelta(pallets, idsToMark, currentWeek, activeTruckId);
  const staleSet = new Set(staleAutoIds);
  const idsToUpdate = new Set([...staleAutoIds, ...assignIds]);
  if (idsToUpdate.size > 0) {
    await runTransaction(db, async (tx) => {
      const guardRef = shipmentMarkingGuardRef();
      const guardSnap = await tx.get(guardRef);
      const allIds = [...idsToUpdate];
      const refs = allIds.map((id) => doc(db, "pallets", id));
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
      const nextRevision = nextShipmentMarkingRevision(
        Number(guardSnap.data()?.revision ?? 0), observedMarkingRevision);

      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists()) return;
        const pallet = { id: snapshot.id, ...snapshot.data() } as Pallet;
        if (staleSet.has(pallet.id)) {
          // Never release a pallet which was manually marked in the meantime.
          const prior = originalAuto.get(pallet.id);
          if (!prior || !pallet.markedForShipment ||
              pallet.autoReservationWeek !== prior.week ||
              (pallet.autoReservationTruckId ?? null) !== prior.truckId) return;
          tx.update(refs[index], {
            markedForShipment: false,
            autoReservationWeek: null,
            autoReservationTruckId: null,
            updatedAt: serverTimestamp(),
          });
          return;
        }
        const prior = originalAuto.get(pallet.id);
        if (!idsToMark.has(pallet.id) ||
            (pallet.markedForShipment && !pallet.autoReservationWeek) ||
            (pallet.markedForShipment && prior &&
              (pallet.autoReservationWeek !== prior.week ||
               (pallet.autoReservationTruckId ?? null) !== prior.truckId)) ||
            !isPlanningShipmentPickZone(pallet.zone) ||
            !expiryIso(pallet.expiryDateStr) ||
            expiryIso(pallet.expiryDateStr)! < expiryCutoff) return;
        tx.update(refs[index], {
          markedForShipment: true,
          autoReservationWeek: currentWeek,
          autoReservationTruckId: activeTruckId,
          updatedAt: serverTimestamp(),
        });
      });
      tx.set(guardRef, shipmentMarkingGuardWrite(nextRevision));
    });
  }

  const result = {
    dispatchDate,
    markedIds: [...idsToMark],
    diagnostics,
  };
  console.info("Shipment reservation sync", result);
  return result;
}

/** Backwards-compatible full re-evaluation used by existing callers. */
export async function syncNearestPlannedShipmentReservations(): Promise<void> {
  await reserveNewPalletsForNearestShipment();
}

/**
 * Planner-only view adapter. The existing weekly picker historically checks
 * `zone === "cooler"`; normalize all shippable storage zones into that pool
 * while preserving every other pallet field and keeping loadingDock excluded.
 */
export function palletsForPlanningShipmentPicking(pallets: Pallet[]): Pallet[] {
  return pallets.map((pallet) =>
    isPlanningShipmentPickZone(pallet.zone)
      ? { ...pallet, zone: "cooler" as PalletZone }
      : pallet,
  );
}

export function samePlannedProduct(pallet: Pallet, beerStyle: string, itemType: Pallet["itemType"]): boolean {
  return pallet.itemType === itemType && sameStyle(pallet.beerStyle, beerStyle);
}
