/** Compare the actual physical load to the selected, immutable planned trip.
 * Extra and unrecognized SKUs remain visible; different products are never
 * treated as equivalent merely because their quantities happen to match.
 */
export type DispatchQuantityLine = { productId: string; quantity: number };

export type DispatchVariance = {
  productId: string;
  planned: number;
  actual: number;
  difference: number;
};

function quantityMap(lines: readonly DispatchQuantityLine[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of lines) {
    const productId = String(line.productId ?? "").trim();
    const quantity = Number(line.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity < 0)
      throw new Error("נתוני הכמויות להשוואת המשלוח אינם תקינים");
    if (quantity > 0) result.set(productId, (result.get(productId) ?? 0) + quantity);
  }
  return result;
}

export function compareDispatchManifests(
  planned: readonly DispatchQuantityLine[],
  actual: readonly DispatchQuantityLine[],
): DispatchVariance[] {
  const expected = quantityMap(planned);
  const loaded = quantityMap(actual);
  return [...new Set([...expected.keys(), ...loaded.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .map((productId) => {
      const planned = expected.get(productId) ?? 0;
      const actual = loaded.get(productId) ?? 0;
      return { productId, planned, actual, difference: actual - planned };
    })
    .filter((line) => line.difference !== 0);
}

export function sameDispatchManifest(
  first: readonly DispatchQuantityLine[],
  second: readonly DispatchQuantityLine[],
): boolean {
  return compareDispatchManifests(first, second).length === 0;
}
