import {
  collection,
  doc,
  getDocsFromServer,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { getCatalogEntry } from "../cooler/PalletCatalog";
import type { Pallet, PalletZone } from "../cooler/Pallettypes ";
import { dateKey, sameStyle, weekStart, type WeekPlan } from "./planningEngine";
import { expiryIso, palletQuantity } from "./shipmentPicking";
import { shipmentDecisionPickOptions } from "./shipmentDecisionPicking";

const PICKABLE_ZONES: PalletZone[] = ["cooler", "pending", "bottleRoom"];

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

/**
 * The saved weekly delivery decision is the reservation source of truth.
 * We deliberately do not create a second reservation collection: future
 * packaging simply fills the nearest still-open planned delivery.
 */
async function nearestPlannedDelivery(today: string): Promise<PlannedLine[]> {
  // Operational packaging users are approved brewery users, but they are not
  // necessarily planners. Read the restricted shipment projection instead of
  // the full planningWeeks documents (same pattern as brewPlanningQueue).
  const snapshot = await getDocsFromServer(
    query(collection(db, "shipmentPlanningQueue"), where("id", ">=", weekStart(today)))
  );

  const lines = snapshot.docs.flatMap((snapshot) => {
    const week = snapshot.data() as WeekPlan;
    return (week.deliveries ?? [])
      .filter((delivery) => delivery.quantity > 0 && delivery.dispatchDate >= today)
      .map((delivery) => ({
        productId: delivery.productId,
        quantity: delivery.quantity,
        dispatchDate: delivery.dispatchDate,
      }));
  });

  const nearestDate = lines.map((line) => line.dispatchDate).sort()[0];
  if (!nearestDate) return [];

  const totals = new Map<string, PlannedLine>();
  for (const line of lines.filter((item) => item.dispatchDate === nearestDate)) {
    const previous = totals.get(line.productId);
    totals.set(line.productId, {
      productId: line.productId,
      dispatchDate: nearestDate,
      quantity: (previous?.quantity ?? 0) + line.quantity,
    });
  }
  return [...totals.values()];
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
  const planned = await nearestPlannedDelivery(today);
  const dispatchDate = planned[0]?.dispatchDate ?? null;
  const diagnostics: ShipmentReservationSyncResult["diagnostics"] = [];
  if (!planned.length) return { dispatchDate, markedIds: [], diagnostics };

  const palletSnapshot = await getDocsFromServer(collection(db, "pallets"));
  const pallets = palletSnapshot.docs.map(
    (snapshot) => ({ id: snapshot.id, ...snapshot.data() }) as Pallet,
  );
  const newIds = new Set(newPalletIds);
  const idsToMark = new Set<string>();

  for (const line of planned) {
    const matching = pallets.filter((pallet) =>
      pallet.zone !== "shipped" &&
      palletQuantity(pallet) > 0 &&
      skuForPallet(pallet) === line.productId,
    );

    const alreadyMarked = matching.filter((pallet) => pallet.markedForShipment);
    const itemType = matching[0]?.itemType;
    const unitPerPallet = itemType ? palletSize(itemType) : 0;
    const markedPhysicalQuantity = alreadyMarked.reduce(
      (sum, pallet) => sum + palletQuantity(pallet),
      0,
    );
    const markedNominalQuantity = unitPerPallet > 0
      ? Math.min(line.quantity, alreadyMarked.length * unitPerPallet)
      : markedPhysicalQuantity;
    const missingBefore = Math.max(0, line.quantity - markedNominalQuantity);

    const candidates = matching.filter((pallet) =>
      !pallet.markedForShipment &&
      isPlanningShipmentPickZone(pallet.zone) &&
      !!expiryIso(pallet.expiryDateStr) &&
      expiryIso(pallet.expiryDateStr)! >= today,
    );

    // Important: new pallets only trigger this pass; they do not jump the queue.
    // The normal picker keeps FEFO first and only uses access/proximity as a
    // secondary tie-breaker inside the same expiry priority.
    const selected = pickForMissing(candidates, missingBefore);
    const selectedNominal = selected.length > 0
      ? selected.length * palletSize(selected[0].itemType)
      : 0;
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

  if (idsToMark.size > 0) {
    await runTransaction(db, async (tx) => {
      const refs = [...idsToMark].map((id) => doc(db, "pallets", id));
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));

      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists()) return;
        const pallet = { id: snapshot.id, ...snapshot.data() } as Pallet;
        if (
          pallet.markedForShipment ||
          !isPlanningShipmentPickZone(pallet.zone) ||
          !expiryIso(pallet.expiryDateStr) ||
          expiryIso(pallet.expiryDateStr)! < today
        ) return;

        tx.update(refs[index], {
          markedForShipment: true,
          updatedAt: serverTimestamp(),
        });
      });
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
