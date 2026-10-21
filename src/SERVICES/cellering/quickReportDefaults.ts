import type { PressureTargetSpecs } from "./pressureStyleTarget";
import { getClosingPressureForStyle } from "./pressureStyleTarget";

/** Use the configured style pressure for valve adjustment and tank closing.
 * If specs are not available, leave the field empty rather than guessing.
 * The caller still owns an editable field; this only supplies its initial value.
 */
export function getQuickReportPressureDefault(
  noteType: string,
  beerStyle: string | null | undefined,
  specs: PressureTargetSpecs | null,
): string | null {
  if (noteType !== "פורק" && noteType !== "סגירת מיכל") return null;
  if (!specs) return null;
  const target = getClosingPressureForStyle(beerStyle, specs);
  return target === null || !Number.isFinite(target) ? null : String(target);
}
