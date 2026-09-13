import { calcHeightCm, type Pallet } from "../cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../cooler/truckCapacity";
import { parseDate } from "./planningEngine";

export const expiryIso = parseDate;
export const palletQuantity = (p: Pallet) => Math.max(0, Number(p.quantity) || 0);
export const hasMarkedPallets = (pallets: Pallet[]) =>
  pallets.some((p) => p.zone !== "shipped" && p.markedForShipment);

function stackOrder(p: Pallet) {
  return p.orderInCell ?? p.slotIndex ?? p.cellOrder ?? null;
}

function sameCell(a: Pallet, b: Pallet) {
  return !!a.cell && !!b.cell &&
    a.cell.side === b.cell.side &&
    a.cell.col === b.cell.col &&
    a.cell.row === b.cell.row;
}

/**
 * Accessibility only breaks ties INSIDE the same expiry date.
 * Highest row is nearest the aisle/door. Inside one physical cell, the upper
 * pallet (lowest saved stack order) must always be preferred to the pallet below.
 *
 * Deliberately no id tie-breaker: old/imported pallets can have no stack-order
 * field. In that case Array.sort stays stable and preserves the same Firestore
 * order used by the map instead of producing an arbitrary id-based pattern.
 */
export function compareAccess(a: Pallet, b: Pallet) {
  if (sameCell(a, b)) {
    const aStack = stackOrder(a);
    const bStack = stackOrder(b);
    if (aStack !== null && bStack !== null && aStack !== bStack) return aStack - bStack;
  }

  return (b.cell?.row ?? -1) - (a.cell?.row ?? -1) ||
    (a.cell?.col ?? Infinity) - (b.cell?.col ?? Infinity) ||
    ((stackOrder(a) ?? Infinity) - (stackOrder(b) ?? Infinity));
}

export type PalletSelectionOption = {
  selected: Pallet[];
  total: number;
  slots: number;
  overage: number;
  /** Lower is better. Final FEFO/access rank consumed by the UI combiner. */
  fefoScore: number;
};

function heightSignature(selected: Pallet[]) {
  return selected
    .map((p) => calcHeightCm(p.itemType, p.quantity))
    .sort((a, b) => a - b)
    .join(",");
}

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
 * Find the largest quantity <= target that can be taken from ONE expiry batch.
 * Among equal totals, retain the most accessible subset for every height signature.
 *
 * This is the important FEFO rule: we maximize usage of the current (earliest)
 * expiry BEFORE looking at a later expiry. A later 84-unit pallet therefore cannot
 * replace an earlier 82-unit pallet merely because 84 happens to hit the decision
 * exactly. On the other hand, within one expiry, [20,20] correctly beats [4,20]
 * for a target of 40, so a tiny partial pallet is skipped when full pallets satisfy
 * more of the decision.
 */
function bestWithinExpiry(
  group: Pallet[],
  target: number,
  globalPriorityById: Map<string, number>,
): PalletSelectionOption[] {
  if (target <= 0 || !group.length) {
    return [{ selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 }];
  }

  const states = new Map<number, Map<string, PalletSelectionOption>>();
  states.set(0, new Map([["", { selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 }]]));

  for (const pallet of group) {
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

        const next: PalletSelectionOption = {
          selected,
          total: nextTotal,
          slots,
          overage: 0,
          fefoScore: 0,
        };
        const key = heightSignature(selected);
        const bucket = states.get(nextTotal) ?? new Map<string, PalletSelectionOption>();
        const previous = bucket.get(key);

        if (!previous || compareSelectionPriority(next, previous, globalPriorityById) < 0) {
          bucket.set(key, next);
        }
        states.set(nextTotal, bucket);
      }
    }
  }

  const bestTotal = Math.max(...states.keys());
  return [...(states.get(bestTotal)?.values() ?? [])].sort((a, b) =>
    compareSelectionPriority(a, b, globalPriorityById),
  );
}

/**
 * Never exceed the decision.
 *
 * Selection is expiry-tiered FEFO:
 *   1. earliest expiry first;
 *   2. take the maximum usable quantity from that expiry;
 *   3. only then continue to the next expiry;
 *   4. inside the same expiry, accessibility decides between equivalent subsets.
 *
 * This is intentionally different from a global subset-sum search. A global search
 * can silently skip older stock just to reach a prettier exact total with newer stock,
 * which is precisely what FEFO must prevent.
 */
export function palletSelectionOptions(
  candidates: Pallet[],
  target: number,
  allowPartial = false,
): PalletSelectionOption[] {
  if (!Number.isInteger(target) || target < 0) return [];

  const originalIndex = new Map(candidates.map((p, index) => [p.id, index]));
  const ordered = [...candidates]
    .filter((p) => Number.isInteger(p.quantity) && p.quantity > 0)
    .sort((a, b) =>
      String(expiryIso(a.expiryDateStr) ?? "9999-12-31").localeCompare(
        String(expiryIso(b.expiryDateStr) ?? "9999-12-31"),
      ) ||
      compareAccess(a, b) ||
      (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0),
    );

  const priorityById = new Map(ordered.map((p, index) => [p.id, index]));
  const expiryGroups: Pallet[][] = [];
  for (const pallet of ordered) {
    const expiry = String(expiryIso(pallet.expiryDateStr) ?? "9999-12-31");
    const last = expiryGroups[expiryGroups.length - 1];
    if (!last || String(expiryIso(last[0].expiryDateStr) ?? "9999-12-31") !== expiry) {
      expiryGroups.push([pallet]);
    } else {
      last.push(pallet);
    }
  }

  let remaining = target;
  let states: PalletSelectionOption[] = [
    { selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 },
  ];

  for (const group of expiryGroups) {
    if (remaining <= 0) break;
    const groupOptions = bestWithinExpiry(group, remaining, priorityById);
    const takenFromExpiry = groupOptions[0]?.total ?? 0;
    if (takenFromExpiry <= 0) continue;

    const nextBySignature = new Map<string, PalletSelectionOption>();
    for (const state of states) {
      for (const option of groupOptions) {
        const selected = [...state.selected, ...option.selected];
        let slots: number;
        try {
          slots = calcTruckSlots(selected);
        } catch {
          continue;
        }
        if (slots > MAX_TRUCK_SLOTS) continue;

        const next: PalletSelectionOption = {
          selected,
          total: state.total + option.total,
          slots,
          overage: 0,
          fefoScore: 0,
        };
        const key = heightSignature(selected);
        const previous = nextBySignature.get(key);
        if (!previous || compareSelectionPriority(next, previous, priorityById) < 0) {
          nextBySignature.set(key, next);
        }
      }
    }

    states = [...nextBySignature.values()];
    if (!states.length) return [];
    remaining -= takenFromExpiry;
  }

  const selectedTotal = target - remaining;
  if (!allowPartial && selectedTotal !== target) return [];

  const preferred = states
    .filter((option) => option.total === selectedTotal)
    .sort((a, b) => compareSelectionPriority(a, b, priorityById));

  return preferred.map((option, rank) => ({ ...option, fefoScore: rank }));
}
