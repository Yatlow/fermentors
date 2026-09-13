import { calcHeightCm, type Pallet } from "../cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../cooler/truckCapacity";
import { parseDate } from "./planningEngine";

export const expiryIso = parseDate;
export const palletQuantity = (p: Pallet) => Math.max(0, Number(p.quantity) || 0);
export const hasMarkedPallets = (pallets: Pallet[]) =>
  pallets.some((p) => p.zone !== "shipped" && p.markedForShipment);

/** Highest row is nearest the door on both sides; the lowest order is on top. */
export function compareAccess(a: Pallet, b: Pallet) {
  return (b.cell?.row ?? -1) - (a.cell?.row ?? -1) ||
    (a.orderInCell ?? a.slotIndex ?? 0) - (b.orderInCell ?? b.slotIndex ?? 0) ||
    (a.cell?.col ?? Infinity) - (b.cell?.col ?? Infinity) ||
    a.id.localeCompare(b.id);
}

export type PalletSelectionOption = {
  selected: Pallet[];
  total: number;
  slots: number;
  overage: number;
  fefoScore: number;
};

/** Never exceed the decision. Partial mode selects the largest available subset.
 * Height-equivalent subsets have identical capacity;
 * retain the preferred subset for each quantity and height signature. */
export function palletSelectionOptions(candidates: Pallet[], target: number, allowPartial = false): PalletSelectionOption[] {
  if (!Number.isInteger(target) || target < 0) return [];
  const ordered = [...candidates].filter((p) => Number.isInteger(p.quantity) && p.quantity > 0)
    .sort((a, b) => String(expiryIso(a.expiryDateStr) ?? "9999-12-31").localeCompare(String(expiryIso(b.expiryDateStr) ?? "9999-12-31")) || compareAccess(a, b));
  const states = new Map<number, Map<string, PalletSelectionOption>>();
  states.set(0, new Map([["", { selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 }]]));
  for (let index = 0; index < ordered.length; index++) {
    const pallet = ordered[index];
    // Descending totals prevent reusing the same physical pallet.
    for (const total of [...states.keys()].sort((a, b) => b - a)) {
      const nextTotal = total + pallet.quantity;
      if (nextTotal > target) continue;
      for (const option of states.get(total)!.values()) {
        const selected = [...option.selected, pallet];
        let slots: number;
        try { slots = calcTruckSlots(selected); } catch { continue; }
        if (slots > MAX_TRUCK_SLOTS) continue;
        const key = selected.map((p) => calcHeightCm(p.itemType, p.quantity)).sort((a, b) => a - b).join(",");
        const next = { selected, total: nextTotal, slots, overage: 0, fefoScore: option.fefoScore + index };
        const bucket = states.get(nextTotal) ?? new Map<string, PalletSelectionOption>();
        const previous = bucket.get(key);
        if (!previous || next.fefoScore < previous.fefoScore) bucket.set(key, next);
        states.set(nextTotal, bucket);
      }
    }
  }
  const selectedTotal = allowPartial ? Math.max(...states.keys()) : target;
  return [...(states.get(selectedTotal)?.values() ?? [])].sort((a, b) => a.fefoScore - b.fefoScore || a.slots - b.slots);
}
