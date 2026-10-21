export type PressureTargetSpecs = { pressure?: Record<string, number> };

/** Shared source for the configured target pressure of a beer style.
 * Kept independent from UI, Firebase and the brewing ingredient library.
 */
export function getClosingPressureForStyle(
  beerStyle: string | null | undefined,
  specs: PressureTargetSpecs,
): number | null {
  const pressureSpecs = specs?.pressure;
  if (!pressureSpecs) return null;
  const normalizedStyle = String(beerStyle || "").trim().toLowerCase().split(/\s+/)[0];
  const value = pressureSpecs[normalizedStyle] ?? pressureSpecs.other;
  return typeof value === "number" ? value : null;
}
