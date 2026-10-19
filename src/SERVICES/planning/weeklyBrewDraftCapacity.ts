import type { BrewSizeLabel } from "./productionCycle";

/**
 * Weekly planning's availableBrewTanks and brewTankOptions describe the
 * *remaining* unreserved tanks. Existing planned brews have already consumed
 * their capacity and must not be counted against that remainder again.
 */
export function weeklyBrewDraftCapacity(
  existingSizes: BrewSizeLabel[],
  freeSizes: BrewSizeLabel[],
) {
  const bySize = (size: BrewSizeLabel) =>
    existingSizes.filter((item) => item === size).length +
    freeSizes.filter((item) => item === size).length;
  return { total: existingSizes.length + freeSizes.length, bySize };
}
