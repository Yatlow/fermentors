import { calcTruckSlots } from "../cooler/truckCapacity";
import type { Pallet } from "../cooler/Pallettypes ";
import { compareAccess, expiryIso, palletQuantity, palletSelectionOptions } from "./shipmentPicking";

export type ShipmentDecisionPick = {
  selected: Pallet[];
  actualTotal: number;
  nominalCovered: number;
  missingNominal: number;
  partialEquivalentGap: number;
  slots: number;
  fefoScore: number;
  overage: number;
};

function orderedCandidates(candidates: Pallet[]) {
  const originalIndex = new Map(candidates.map((p, index) => [p.id, index]));
  return [...candidates].sort((a, b) =>
    String(expiryIso(a.expiryDateStr) ?? "9999-12-31").localeCompare(
      String(expiryIso(b.expiryDateStr) ?? "9999-12-31"),
    ) ||
    compareAccess(a, b) ||
    (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0),
  );
}

/**
 * Weekly shipment decisions are made in pallet slots rather than fractions.
 *
 * We first keep the normal FEFO/physical extraction logic. If the selected stock
 * is a partial pallet, that physical pallet is allowed to satisfy one nominal
 * pallet slot. This keeps the planning UI on whole pallets while the cooler map
 * still marks the real physical pallet and quantity.
 *
 * We never use more physical pallets than the number of pallet slots requested.
 * If fewer pallet objects exist than requested, the remaining pallet slots stay
 * missing and are reported to the planner.
 */
export function shipmentDecisionPickOptions(
  candidates: Pallet[],
  requestedUnits: number,
  palletSize: number,
): ShipmentDecisionPick[] {
  if (!Number.isFinite(requestedUnits) || requestedUnits <= 0 || palletSize <= 0) {
    return [{
      selected: [], actualTotal: 0, nominalCovered: 0, missingNominal: 0,
      partialEquivalentGap: 0, slots: 0, fefoScore: 0, overage: 0,
    }];
  }

  const targetPallets = Math.ceil(requestedUnits / palletSize);
  const baseOptions = palletSelectionOptions(candidates, requestedUnits, true);
  const sourceOptions = baseOptions.length
    ? baseOptions
    : [{ selected: [], total: 0, slots: 0, overage: 0, fefoScore: 0 }];

  const results: ShipmentDecisionPick[] = sourceOptions.map((option) => {
    let selected = option.selected;

    // A one-pallet decision should not turn into several tiny physical pallets.
    // Keep the best FEFO/access pallets up to the number of requested pallet slots.
    if (selected.length > targetPallets) {
      const selectedIds = new Set(selected.map((p) => p.id));
      selected = orderedCandidates(candidates)
        .filter((p) => selectedIds.has(p.id))
        .slice(0, targetPallets);
    }

    // When the quantity search did not use enough pallet objects to represent the
    // requested slots, fill remaining slots with the next FEFO/access partials.
    if (selected.length < targetPallets) {
      const selectedIds = new Set(selected.map((p) => p.id));
      const additions = orderedCandidates(candidates)
        .filter((p) => !selectedIds.has(p.id))
        .slice(0, targetPallets - selected.length);
      selected = [...selected, ...additions];
    }

    const actualTotal = selected.reduce((sum, p) => sum + palletQuantity(p), 0);
    const nominalCovered = Math.min(requestedUnits, selected.length * palletSize);
    const missingNominal = Math.max(0, requestedUnits - nominalCovered);
    const partialEquivalentGap = Math.max(0, nominalCovered - actualTotal);
    let slots = 0;
    try {
      slots = selected.length ? calcTruckSlots(selected) : 0;
    } catch {
      slots = Infinity;
    }

    return {
      selected,
      actualTotal,
      nominalCovered,
      missingNominal,
      partialEquivalentGap,
      slots,
      fefoScore: option.fefoScore,
      overage: option.overage,
    };
  });

  const deduped = new Map<string, ShipmentDecisionPick>();
  for (const option of results) {
    const key = option.selected.map((p) => p.id).sort().join("|");
    const previous = deduped.get(key);
    if (!previous ||
        option.missingNominal < previous.missingNominal ||
        (option.missingNominal === previous.missingNominal && option.fefoScore < previous.fefoScore) ||
        (option.missingNominal === previous.missingNominal && option.fefoScore === previous.fefoScore && option.slots < previous.slots)) {
      deduped.set(key, option);
    }
  }

  return [...deduped.values()].sort((a, b) =>
    a.missingNominal - b.missingNominal ||
    a.fefoScore - b.fefoScore ||
    a.slots - b.slots ||
    a.partialEquivalentGap - b.partialEquivalentGap,
  );
}
