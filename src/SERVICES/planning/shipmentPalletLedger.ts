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

/** Physical FEFO departure. Pallets are indivisible, so partial stock may
 * need more floor slots but must NEVER silently over-ship past the manifest.
 * Within one expiry date the subset search maximizes physically shipped
 * units, then the truck-capacity audit validates the entire selected load.
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
  // FEFO precedence is by expiry tier. Within one tier select the largest
  // whole-pallet quantity NOT exceeding the remaining manifest (bounded
  // subset-sum). A greedy "keep picking until >= target" silently ships 90
  // physical crates for an 84-crate plan, while crediting only 84 to Tempo.
  // It also consumes pallets that never truly needed to leave the brewery.
  // Do not silently overdispatch. Two half-pallets MAY fill one nominal slot
  // request, but all real physical positions must be checked by truck audit.
  const selected: ForecastPalletLot[] = [];
  const remainingLots: ForecastPalletLot[] = [];
  let shippedPhysical = 0;
  for (let start = 0; start < lots.length;) {
    const expiry = lots[start].expiry;
    let end = start + 1;
    while (end < lots.length && lots[end].expiry === expiry) end++;
    const tier = lots.slice(start, end);
    start = end;
    const need = Math.max(0, quantity - shippedPhysical);
    if (need < 0.00001) {
      remainingLots.push(...tier);
      continue;
    }
    // Pallet quantities are normally integers. Quantizing to 0.001 keeps
    // legacy fractional units deterministic and avoids floating-point keys.
    const reachable = new Map<number, number[]>([[0, []]]);
    for (let index = 0; index < tier.length; index++) {
      const amount = tier[index].quantity;
      if (!Number.isFinite(amount) || amount <= 0) {
        continue;
      }
      const states = [...reachable.entries()];
      for (const [sum, picked] of states) {
        const total = Math.round((sum + amount) * 1000) / 1000;
        if (total > need + 0.00001 || reachable.has(total)) continue;
        reachable.set(total, [...picked, index]);
      }
    }
    let best = 0;
    for (const sum of reachable.keys()) if (sum > best) best = sum;
    const chosen = new Set(reachable.get(best) ?? []);
    for (let index = 0; index < tier.length; index++) {
      if (chosen.has(index)) selected.push(tier[index]);
      else remainingLots.push(tier[index]);
    }
    shippedPhysical += best;
  }
  lots.splice(0, lots.length, ...remainingLots);
  return {
    missingSlots: Math.max(0, nominalSlots - selected.length),
    missingUnits: Math.max(0, quantity - shippedPhysical),
    shippedPhysical,
    provisionalPallets: selected.filter((lot) => lot.provisional).length,
    selectedLots: selected,
  };
}
