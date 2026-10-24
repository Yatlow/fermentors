/**
 * Chronological FEFO ledger. A pallet is one indivisible physical load.
 * Keep this picker shared by daily, weekly and feasibility calculations.
 */
export type ForecastPalletLot = {
  id: string;
  expiry: string;
  quantity: number;
  provisional?: boolean;
};

export type ForecastDispatchResult = {
  missingSlots: number;
  missingUnits: number;
  shippedPhysical: number;
  provisionalPallets: number;
  selectedLots: ForecastPalletLot[];
  /** Explicit physically pinned pallets that were absent/changed/expired/consumed. */
  missingPinnedIds: string[];
};

export const MAX_FEFO_SUBSET_STATES = 4096;

export function addForecastPackaging(
  lots: ForecastPalletLot[],
  quantity: number,
  unitsPerPallet: number,
  idPrefix: string,
): void {
  if (!Number.isFinite(quantity) || quantity <= 0 || unitsPerPallet <= 0) return;
  let remaining = quantity;
  let index = 0;
  while (remaining > 0) {
    const placed = Math.min(unitsPerPallet, remaining);
    lots.push({
      id: `${idPrefix}:${index++}`,
      expiry: "9999-12-31", quantity: placed, provisional: true,
    });
    remaining -= placed;
  }
}

type SubsetNode = {
  index: number;
  parent: SubsetNode | null;
  count: number;
  actual: number;
};

/**
 * At most MAX_FEFO_SUBSET_STATES reachable sums are retained for one expiry
 * tier. Whole-unit crate/keg manifests up to 12 * 84 have <=1009 sums and
 * remain exact. Legacy fractional quantities are approximated conservatively
 * if state-space pruning becomes necessary: never dispatch more than planned.
 *
 * Linked predecessor nodes avoid allocating/copying every selected-index array
 * at each intermediate sum (previous code could consume unbounded memory).
 */
function bestSubsetIndices(
  tier: ForecastPalletLot[],
  need: number,
): ReadonlySet<number> {
  const zero: SubsetNode = { index: -1, parent: null, count: 0, actual: 0 };
  let reachable = new Map<number, SubsetNode>([[0, zero]]);
  const scale = 1000;
  const target = Math.max(0, Math.round(need * scale));
  for (let i = 0; i < tier.length; i++) {
    const qty = tier[i].quantity;
    if (!Number.isFinite(qty) || qty <= 0 || qty > need + 1e-9) continue;
    const amount = Math.round(qty * scale);
    if (amount <= 0) continue;
    const snapshot = [...reachable];
    for (const [sum, state] of snapshot) {
      const total = sum + amount;
      if (total > target || state.actual + qty > need + 1e-9) continue;
      const previous = reachable.get(total);
      if (!previous || previous.count > state.count + 1) {
        reachable.set(total, {
          index: i, parent: state, count: state.count + 1,
          actual: state.actual + qty,
        });
      }
    }
    if (reachable.size > MAX_FEFO_SUBSET_STATES) {
      // Bound memory and work even on adversarial fractional historical lots.
      // Preserve zero for future combinations; prioritize closest feasible
      // sums, with fewer pallets as the deterministic tie breaker.
      const candidates = [...reachable].filter(([sum]) => sum !== 0)
        .sort((a, b) => b[0] - a[0] || a[1].count - b[1].count)
        .slice(0, MAX_FEFO_SUBSET_STATES - 1);
      reachable = new Map([[0, zero], ...candidates]);
    }
    if (reachable.get(target)?.actual === need) break;
  }

  let best: SubsetNode = zero;
  for (const state of reachable.values()) {
    if (state.actual > best.actual + 1e-9 ||
        (Math.abs(state.actual - best.actual) <= 1e-9 &&
          state.count < best.count)) best = state;
  }
  const indices = new Set<number>();
  for (let node: SubsetNode | null = best; node && node.index >= 0; node = node.parent)
    indices.add(node.index);
  return indices;
}

/**
 * Removes only pallets actually forecast to leave. An explicit physical pick
 * is honored BY ID instead of silently replacing it with arbitrary FEFO stock.
 * `planning:` placeholders are not physical reservations; their quantity can
 * be filled by eligible FEFO stock after its planned packaging date.
 *
 * A missing explicit pallet is reported, never substituted automatically.
 * Other FEFO picks respect the manifest cap, expiry tiers, whole physical
 * pallets and bounded subset search.
 */
export function dispatchForecastPallets(
  lots: ForecastPalletLot[],
  quantity: number,
  unitsPerPallet: number,
  date: string,
  assignedPallets?: ReadonlyArray<{ id: string; quantity: number }>,
): ForecastDispatchResult {
  for (let i = lots.length - 1; i >= 0; i--)
    if (lots[i].expiry < date) lots.splice(i, 1);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitsPerPallet) ||
      unitsPerPallet <= 0) {
    return { missingSlots: 0, missingUnits: 0, shippedPhysical: 0,
      provisionalPallets: 0, selectedLots: [], missingPinnedIds: [] };
  }

  lots.sort((a, b) =>
    a.expiry.localeCompare(b.expiry) ||
    b.quantity - a.quantity ||
    a.id.localeCompare(b.id));

  const selected: ForecastPalletLot[] = [];
  const missingPinnedIds: string[] = [];
  const fixed = (assignedPallets ?? []).filter((p) => !p.id.startsWith("planning:"));
  for (const assigned of fixed) {
    const index = lots.findIndex((lot) => lot.id === assigned.id &&
      Math.abs(lot.quantity - assigned.quantity) <= 1e-6 &&
      selected.reduce((sum, item) => sum + item.quantity, 0) +
        lot.quantity <= quantity + 1e-9);
    if (index < 0) {
      missingPinnedIds.push(assigned.id);
      continue;
    }
    selected.push(lots.splice(index, 1)[0]);
  }

  const fixedQuantity = selected.reduce((sum, lot) => sum + lot.quantity, 0);
  const flexibleQuantity = assignedPallets?.length
    ? (assignedPallets.filter((p) => p.id.startsWith("planning:"))
        .reduce((sum, p) => sum + Math.max(0, Number(p.quantity) || 0), 0))
    : quantity;
  const limit = Math.max(0, Math.min(quantity - fixedQuantity, flexibleQuantity));
  const remainingLots: ForecastPalletLot[] = [];
  let flexibleShipped = 0;
  for (let start = 0; start < lots.length;) {
    const expiry = lots[start].expiry;
    let end = start + 1;
    while (end < lots.length && lots[end].expiry === expiry) end++;
    const tier = lots.slice(start, end);
    start = end;
    const need = Math.max(0, limit - flexibleShipped);
    if (need < 1e-9) {
      remainingLots.push(...tier);
      continue;
    }
    const chosen = bestSubsetIndices(tier, need);
    for (let index = 0; index < tier.length; index++) {
      if (chosen.has(index)) {
        selected.push(tier[index]);
        flexibleShipped += tier[index].quantity;
      } else {
        remainingLots.push(tier[index]);
      }
    }
  }
  lots.splice(0, lots.length, ...remainingLots);
  const shippedPhysical = fixedQuantity + flexibleShipped;
  return {
    missingSlots: Math.max(0, Math.ceil(quantity / unitsPerPallet) - selected.length),
    missingUnits: Math.max(0, quantity - shippedPhysical),
    shippedPhysical,
    provisionalPallets: selected.filter((lot) => lot.provisional).length,
    selectedLots: selected,
    missingPinnedIds,
  };
}
