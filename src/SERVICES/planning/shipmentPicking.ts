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
  /** Kept for compatibility/debugging only; selection is NOT ranked by this sum. */
  fefoScore: number;
};

/**
 * Compare two subsets by the actual ordered pallet priority, not by a summed score.
 *
 * `ordered` is already FEFO first and accessibility second, so comparing the first
 * differing selected index gives us a strict hierarchy:
 *   1. earliest expiry
 *   2. best access within the same expiry
 *   3. next-best pallet, and so on
 *
 * This avoids ties such as [0, 4] vs [1, 3], which had the same summed score even
 * though the first subset correctly contains the highest-priority pallet.
 */
function compareSelectionPriority(
  a: PalletSelectionOption,
  b: PalletSelectionOption,
  priorityById: Map<string, number>,
) {
  const aIndexes = a.selected.map((p) => priorityById.get(p.id) ?? Infinity);
  const bIndexes = b.selected.map((p) => priorityById.get(p.id) ?? Infinity);
  const length = Math.min(aIndexes.length, bIndexes.length);

  for (let i = 0; i < length; i++) {
    if (aIndexes[i] !== bIndexes[i]) return aIndexes[i] - bIndexes[i];
  }

  return aIndexes.length - bIndexes.length || a.slots - b.slots;
}

/**
 * Never exceed the decision. Partial mode selects the largest available subset.
 *
 * FEFO/accessibility are hard ordering priorities, not an additive score. We may
 * still skip a pallet when it is impossible to hit the requested quantity without
 * exceeding it, but among all feasible subsets we always choose the lexicographically
 * earliest subset from the FEFO/access ordered candidate list.
 *
 * Height-equivalent subsets have identical truck-capacity behavior, so for each
 * quantity + height signature we only need to retain the strictly preferred subset.
 */
export function palletSelectionOptions(
  candidates: Pallet[],
  target: number,
  allowPartial = false,
): PalletSelectionOption[] {
  if (!Number.isInteger(target) || target < 0) return [];

  const ordered = [...candidates]
    .filter((p) => Number.isInteger(p.quantity) && p.quantity > 0)
    .sort(
      (a, b) =>
        String(expiryIso(a.expiryDateStr) ?? "9999-12-31").localeCompare(
          String(expiryIso(b.expiryDateStr) ?? "9999-12-31"),
        ) || compareAccess(a, b),
    );

  const priorityById = new Map(ordered.map((p, index) => [p.id, index]));
  const states = new Map<number, Map<string, PalletSelectionOption>>();
  states.set(
    0,
    new Map([
      ["", { selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 }],
    ]),
  );

  for (let index = 0; index < ordered.length; index++) {
    const pallet = ordered[index];

    // Descending totals prevent reusing the same physical pallet.
    for (const total of [...states.keys()].sort((a, b) => b - a)) {
      const nextTotal = total + pallet.quantity;
      if (nextTotal > target) continue;

      for (const option of states.get(total)!.values()) {
        const selected = [...option.selected, pallet];

        let slots: number;
        try {
          slots = calcTruckSlots(selected);
        } catch {
          continue;
        }
        if (slots > MAX_TRUCK_SLOTS) continue;

        const key = selected
          .map((p) => calcHeightCm(p.itemType, p.quantity))
          .sort((a, b) => a - b)
          .join(",");

        const next: PalletSelectionOption = {
          selected,
          total: nextTotal,
          slots,
          overage: 0,
          fefoScore: option.fefoScore + index,
        };

        const bucket = states.get(nextTotal) ?? new Map<string, PalletSelectionOption>();
        const previous = bucket.get(key);

        if (!previous || compareSelectionPriority(next, previous, priorityById) < 0) {
          bucket.set(key, next);
        }

        states.set(nextTotal, bucket);
      }
    }
  }

  const selectedTotal = allowPartial ? Math.max(...states.keys()) : target;

  return [...(states.get(selectedTotal)?.values() ?? [])].sort((a, b) =>
    compareSelectionPriority(a, b, priorityById),
  );
}
