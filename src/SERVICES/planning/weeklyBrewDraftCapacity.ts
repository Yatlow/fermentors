import { addDays, type BrewPlan } from "./planningEngine";
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

/** The weekly editor edits decisions, it must NOT recreate previously saved brews. */
export type EditableWeeklyBrew = {
  id?: string;
  style: string;
  liters: number;
  allowUnavailable?: boolean;
};

export function materializeWeeklyBrewDraft(
  existingBrews: BrewPlan[],
  draft: EditableWeeklyBrew[],
  week: string,
  makeId: () => string,
): BrewPlan[] {
  const byId = new Map(existingBrews.map((brew) => [brew.id, brew]));
  const seenIds = new Set<string>();

  return draft.filter((item) => item.style && item.liters > 0).map((item) => {
    const original = item.id ? byId.get(item.id) : undefined;
    if (!original) return {
      id: makeId(),
      style: item.style,
      liters: item.liters,
      tankId: "",
      date: addDays(week, 1),
    };

    if (seenIds.has(original.id)) throw new Error("אותו בישול מופיע פעמיים בטיוטה");
    seenIds.add(original.id);

    if (original.style === item.style && original.liters === item.liters) {
      // Critical: preserve id, tank, batch, date and the canonical physical
      // lifecycle link, including optional fields not displayed in the editor.
      return { ...original };
    }

    // Changing a committed brew in the weekly style/size picker would silently
    // sever its tank and packaging/cycle links. Require the dedicated daily
    // assignment workflow rather than destroying that decision.
    if (original.tankId || original.batchNumber || original.linkedExistingBrewId) {
      throw new Error(
        `בישול ${original.batchNumber ?? original.id} כבר משויך למיכל או לאצווה. יש לערוך את השיבוץ שלו בלוח העבודה לפני שינוי הסגנון או הגודל.`
      );
    }
    return { ...original, style: item.style, liters: item.liters };
  });
}
