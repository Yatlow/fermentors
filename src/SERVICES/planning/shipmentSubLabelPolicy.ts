/** Sub-labeled stock requires a human shipment decision; it is never an
 * automatic substitute for the standard SKU, even when FEFO ranks it first.
 */
export function hasPalletSubLabel(pallet: { subLabel?: string | null }): boolean {
  return String(pallet.subLabel ?? "").trim().length > 0;
}

export function splitShipmentAutoPicks<T extends { subLabel?: string | null }>(
  proposed: readonly T[],
): { ordinary: T[]; awaitingPlanner: T[] } {
  return {
    ordinary: proposed.filter((pallet) => !hasPalletSubLabel(pallet)),
    awaitingPlanner: proposed.filter(hasPalletSubLabel),
  };
}
