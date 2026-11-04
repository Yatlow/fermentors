/**
 * Recover mash timeline cells saved in Firestore but missing in the Sheet.
 * Only use row addresses discovered from this exact batch's live, semantically
 * labelled Sheet rows. Never use fallback row offsets and never overwrite a
 * nonblank cell.
 */
export type MashTimeRecoveryBlock = {
  blockIndex: number;
  appFields: Readonly<Record<string, string>>;
  sheetFields: Readonly<Record<string, string>>;
};

export type MissingMashTimeWrite = {
  blockIndex: number;
  fieldKey: string;
  range: string;
  value: string;
  expectedValue: "";
};

const MASH_STAGE_KEYS = [
  "mashIn", "rest1", "heat1", "rest2", "heat2", "rest3", "heat3",
] as const;

function normalizedTime(value: unknown): string | null {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function planMissingMashTimeSheetWrites(
  blocks: readonly MashTimeRecoveryBlock[],
): MissingMashTimeWrite[] {
  const writes: MissingMashTimeWrite[] = [];
  const usedRanges = new Set<string>();
  for (const { blockIndex, appFields, sheetFields } of blocks) {
    const fermentationRow = Number(sheetFields["__sheetRow.fermentation"]);
    if (!Number.isSafeInteger(fermentationRow) || fermentationRow < 1) continue;
    for (const stage of MASH_STAGE_KEYS) {
      const row = Number(sheetFields[`__sheetRow.stage.${stage}`]);
      if (!Number.isSafeInteger(row) || row < 1 || row >= fermentationRow) {
        continue;
      }
      for (const field of ["start", "end"] as const) {
        const key = `${stage}.${field}`;
        const appTime = normalizedTime(appFields[key]);
        // The Sheet's current value wins unless it is genuinely missing.
        if (!appTime || String(sheetFields[key] ?? "").trim()) continue;
        const range = `'גיליון1'!${field === "start" ? "E" : "F"}${row}`;
        // If a broken map targets two stages at the same cell, don't guess.
        if (usedRanges.has(range)) continue;
        usedRanges.add(range);
        writes.push({ blockIndex, fieldKey: key, range, value: appTime, expectedValue: "" });
      }
    }
  }
  return writes;
}
