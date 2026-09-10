import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../cooler/truckCapacity";
import type { Pallet } from "../cooler/Pallettypes ";
import { num, sameStyle, type Product } from "./planningEngine";
export type StockPallet = { pallet: Pallet; expiry: string; quantity: number };
export type TruckSelection = {
  pallets: Pallet[];
  slots: number;
  unfilled: Record<string, number>;
  warnings: string[];
};
/** Real pallets retain IDs; future pallets are explicit estimates, using the existing 84/20 split. */
export function projectedPallets(
  p: Product,
  quantity: number,
  id: string,
): StockPallet[] {
  const result: StockPallet[] = [];
  const max = p.type === "crates" ? 84 : 20;
  let i = 0,
    remaining = quantity;
  while (remaining > 0.00001) {
    const amount = Math.min(remaining, max);
    result.push({
      quantity: amount,
      expiry: "9999-12-31",
      pallet: {
        id: `planning:${id}:${i++}`,
        beerStyle: p.style,
        itemType: p.type,
        quantity: amount,
        zone: "pending",
        heightUnits: 1,
      },
    });
    remaining -= amount;
  }
  return result;
}
/** Pick whole pallets by urgency, then FIFO/expiry within a product. Shared best-fit stacking model. */
export function selectTruck(
  products: Product[],
  stock: StockPallet[],
  needs: Map<string, number>,
  coverageDays: Map<string, number>,
  batchDates: Map<string, string>,
): TruckSelection {
  const picked: Pallet[] = [],
    warnings: string[] = [],
    unfilled: Record<string, number> = {};
  const ranked = [...products]
    .filter((p) => (needs.get(p.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (coverageDays.get(a.id) ?? Infinity) -
          (coverageDays.get(b.id) ?? Infinity) || a.id.localeCompare(b.id),
    );
  for (const p of ranked) {
    let need = needs.get(p.id) ?? 0;
    const candidates = stock.filter(
      (x) =>
        x.quantity > 0 &&
        x.pallet.itemType === p.type &&
        sameStyle(x.pallet.beerStyle, p.style),
    );
    const production = (x: StockPallet) =>
      batchDates.get(`${String(x.pallet.batchNumber)}:${p.id}`);
    const known = candidates.every((x) => !!production(x));
    candidates.sort(
      (a, b) =>
        Number(
          !!(b.pallet.markedForShipment || b.pallet.zone === "loadingDock"),
        ) -
          Number(
            !!(a.pallet.markedForShipment || a.pallet.zone === "loadingDock"),
          ) ||
        (known
          ? production(a)!.localeCompare(production(b)!)
          : a.expiry.localeCompare(b.expiry)) ||
        a.pallet.id.localeCompare(b.pallet.id),
    );
    for (const lot of candidates) {
      if (need <= 0) break;
      const pallet = { ...lot.pallet, quantity: lot.quantity };
      try {
        if (calcTruckSlots([...picked, pallet]) > MAX_TRUCK_SLOTS) break;
      } catch {
        warnings.push(
          `משטח ${pallet.palletNumber ?? pallet.id} גבוה מדי למשאית; נדרשת חלוקה לפני תכנון משלוח`,
        );
        break;
      }
      picked.push(pallet);
      need -= pallet.quantity;
    }
    unfilled[p.id] = Math.max(0, need);
  }
  return { pallets: picked, slots: calcTruckSlots(picked), unfilled, warnings };
}
export function validateTruckGroups(
  deliveries: {
    dispatchDate: string;
    productId: string;
    quantity: number;
    pallets?: Pallet[];
  }[],
  products: Product[],
  maxDeliveries = 2,
): string | null {
  const dates = [...new Set(deliveries.map((d) => d.dispatchDate))];
  if (dates.length > maxDeliveries) return `עד ${maxDeliveries} משלוחים בשבוע`;
  const seen = new Set<string>();
  for (const date of dates) {
    const manifest: Pallet[] = [];
    for (const d of deliveries.filter((d) => d.dispatchDate === date)) {
      const p = products.find((p) => p.id === d.productId);
      if (!p) continue;
      if (d.pallets?.length) {
        if (
          d.pallets.some(
            (x) => x.itemType !== p.type || !sameStyle(x.beerStyle, p.style),
          ) ||
          Math.abs(
            d.pallets.reduce((s, x) => s + num(x.quantity), 0) - d.quantity,
          ) > 0.001
        )
          return "תכולת המשטחים אינה תואמת לכמות המשלוח";
        for (const pallet of d.pallets) {
          if (seen.has(pallet.id)) return "אותו משטח מופיע ביותר ממשלוח אחד";
          seen.add(pallet.id);
        }
        manifest.push(...d.pallets);
      } else
        manifest.push(
          ...projectedPallets(p, d.quantity, `${date}:${p.id}`).map(
            (x) => x.pallet,
          ),
        );
    }
    try {
      const slots = calcTruckSlots(manifest);
      if (slots > MAX_TRUCK_SLOTS)
        return `${date}: נדרשים ${slots} מקומות; במשאית יש ${MAX_TRUCK_SLOTS}`;
    } catch {
      return `${date}: משטח גבוה מהגובה המותר במשאית`;
    }
  }
  return null;
}
