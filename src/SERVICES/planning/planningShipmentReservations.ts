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

/**
 * The saved weekly delivery decision is the reservation source of truth.
 * We deliberately do not create a second reservation collection: future
 * packaging simply fills the nearest still-open planned delivery.
 */
async function nearestPlannedDelivery(today: string): Promise<PlannedLine[]> {
  const snapshot = await getDocsFromServer(
    query(collection(db, "planningWeeks"), where("id", ">=", weekStart(today)))
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

/**
 * Re-evaluates the nearest planned shipment after packaging created pallets.
 * Existing marked pallets stay marked; missing quantities are filled from
 * cooler + pending + bottle room using the same FEFO picker as the planner.
 * Loading-dock pallets are intentionally not newly selected here.
 */
export async function syncNearestPlannedShipmentReservations(): Promise<void> {
  const today = dateKey(new Date());
  const planned = await nearestPlannedDelivery(today);
  if (!planned.length) return;

  const palletSnapshot = await getDocsFromServer(collection(db, "pallets"));
  const pallets = palletSnapshot.docs.map(
    (snapshot) => ({ id: snapshot.id, ...snapshot.data() }) as Pallet,
  );

  const idsToMark = new Set<string>();

  for (const line of planned) {
    const matching = pallets.filter((pallet) =>
      pallet.zone !== "shipped" &&
      palletQuantity(pallet) > 0 &&
      skuForPallet(pallet) === line.productId,
    );

    const alreadyMarked = matching.filter((pallet) => pallet.markedForShipment);
    const markedQuantity = alreadyMarked.reduce(
      (sum, pallet) => sum + palletQuantity(pallet),
      0,
    );
    const missing = Math.max(0, line.quantity - markedQuantity);
    if (missing <= 0) continue;

    const candidates = matching.filter((pallet) =>
      !pallet.markedForShipment &&
      isPlanningShipmentPickZone(pallet.zone) &&
      !!expiryIso(pallet.expiryDateStr) &&
      expiryIso(pallet.expiryDateStr)! >= today,
    );
    if (!candidates.length) continue;

    const itemType = candidates[0].itemType;
    const options = shipmentDecisionPickOptions(candidates, missing, palletSize(itemType));
    const best = options.sort((a, b) =>
      a.missingNominal - b.missingNominal ||
      a.fefoScore - b.fefoScore ||
      a.slots - b.slots ||
      a.overage - b.overage,
    )[0];

    best?.selected.forEach((pallet) => idsToMark.add(pallet.id));
  }

  if (!idsToMark.size) return;

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
