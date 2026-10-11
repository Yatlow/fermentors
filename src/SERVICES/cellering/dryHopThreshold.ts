/** Shared mapping for actual cellar dry-hop advice and future Plato checks. */
export const DRY_HOP_DEFAULTS = {
  dryHopMinPlatoIpa: 8,
  dryHopMinPlatoPale: 7,
  dryHopMinPlatoHoppy: 6,
} as const;

export type DryHopThresholdKey = keyof typeof DRY_HOP_DEFAULTS;

export function dryHopThresholdKey(styleValue: unknown): DryHopThresholdKey | null {
  const style = String(styleValue ?? "").trim().toLowerCase();
  if (style.includes("ipa")) return "dryHopMinPlatoIpa";
  if (style.includes("פייל") || style.includes("pale")) return "dryHopMinPlatoPale";
  if (style.includes("הופי") || style.includes("hoppy")) return "dryHopMinPlatoHoppy";
  return null;
}

/** Legacy dryHopMinPlato remains stored but does not override distinct style defaults.
 * Only an explicit style setting changes the threshold for that style.
 */
export function dryHopThreshold(style: unknown, tolerances?: Record<string, number>): number | null {
  const key = dryHopThresholdKey(style);
  if (!key) return null;
  const value = tolerances?.[key];
  if (value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  return DRY_HOP_DEFAULTS[key];
}

/** The recipe (not beer-style naming alone) decides whether dry-hop is required.
 * Known styles inherit Specs, other styles must provide a recipe target.
 */
export function recipeDryHopThreshold(
  recipe: { style: string; dryHopTargetPlato?: number; hops: Array<{ purpose: string }> },
  tolerances?: Record<string, number>,
): number | null {
  if (!recipe.hops.some((hop) => hop.purpose === "dryHop")) return null;
  const fromSpecs = dryHopThreshold(recipe.style, tolerances);
  if (fromSpecs !== null) return fromSpecs;
  const target = recipe.dryHopTargetPlato;
  return typeof target === "number" && Number.isFinite(target) && target > 0 && target <= 30
    ? target : null;
}

/** New batches carry explicit recipe intent on the fermentor; old/manual
 * batches have no marker and keep legacy style recognition.
 * For known styles, Specs remains the source of the threshold.
 */
export type BatchDryHopSettings = {
  dryHopRequired?: boolean | null;
  dryHopTargetPlato?: number | null;
};
export function batchDryHopThreshold(
  style: unknown,
  tolerances?: Record<string, number>,
  batch?: BatchDryHopSettings | null,
): number | null {
  if (typeof batch?.dryHopRequired === "boolean") {
    if (!batch.dryHopRequired) return null;
    const configured = dryHopThreshold(style, tolerances);
    if (configured !== null) return configured;
    const target = batch.dryHopTargetPlato;
    return typeof target === "number" && Number.isFinite(target) && target > 0 && target <= 30
      ? target : null;
  }
  // Only unmarked historical batches use the original style inference.
  return dryHopThreshold(style, tolerances);
}
