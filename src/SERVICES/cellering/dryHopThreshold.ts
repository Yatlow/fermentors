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
