/**
 * Physical-pallet FEFO ledger shared by shipment feasibility and week-opening
 * stock. A partially filled pallet is ONE indivisible loading position.
 * Never model it as a fractional pallet that another truck could reuse.
 */
export type ForecastPalletLot = {
  id: string;
  expiry: string;
  /** Actual packaged crates or kegs on this physical loading pallet. */
  quantity: number;
  /** Future packaging has no certified expiry until the lot is produced. */
  provisional?: boolean;
};

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

/** A physical departure removes whole pallets in FEFO order.
 * A partial pallet consumes a loading position. Picking may require MORE
 * physical positions than the nominal pallet count to fulfill actual units.
 * For equal expiry,
 * choose the fullest pallet to avoid avoidable partial-unit shortfalls.
 */
export function dispatchForecastPallets(
  lots: ForecastPalletLot[],
  quantity: number,
  unitsPerPallet: number,
  date: string,
): { missingSlots: number; missingUnits: number; shippedPhysical: number; provisionalPallets: number; selectedLots: ForecastPalletLot[] } {
  for (let i = lots.length - 1; i >= 0; i--) {
    if (lots[i].expiry < date) lots.splice(i, 1);
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || unitsPerPallet <= 0) {
    return { missingSlots: 0, missingUnits: 0, shippedPhysical: 0, provisionalPallets: 0, selectedLots: [] };
  }
  const nominalSlots = Math.ceil(quantity / unitsPerPallet);
  lots.sort((a, b) =>
    a.expiry.localeCompare(b.expiry) ||
    b.quantity - a.quantity ||
    a.id.localeCompare(b.id));
  // Nominal pallet slots are a LOWER bound, not a cap on picking. Two
  // half-full pallets can satisfy 84 crates using two physical positions.
  // Consume intact FEFO pallets until physical UNITS meet the manifest or
  // real stock runs out. Never reuse either partial pallet downstream.
  const selected: ForecastPalletLot[] = [];
  let shippedPhysical = 0;
  while (lots.length > 0 && shippedPhysical + 0.00001 < quantity) {
    const next = lots.shift()!;
    selected.push(next);
    shippedPhysical += next.quantity;
  }
  return {
    missingSlots: Math.max(0, nominalSlots - selected.length),
    missingUnits: Math.max(0, quantity - shippedPhysical),
    shippedPhysical,
    provisionalPallets: selected.filter((lot) => lot.provisional).length,
    selectedLots: selected,
  };
}
