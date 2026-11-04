/**
 * Safe reconciliation of the four water fields in each real A/B/C brew block.
 * Derive row addresses exclusively from the labels discovered in the live
 * Sheet. NEVER fall back to template offsets when repairing historical data.
 * A missing cell is a repair candidate; a populated but different Sheet cell
 * is a conflict that must be resolved by an operator, never overwritten here.
 */
export type BrewWaterField =
  | "hltWaterAmount" | "hltWaterTemp"
  | "lauterWaterAmount" | "lauterWaterTemp";

export type MissingBrewWaterCell = {
  blockIndex: number;
  field: BrewWaterField;
  label: string;
  range: string;
  expected: string;
};

const WATER_FIELDS: Array<{
  field: BrewWaterField;
  rowKey: string;
  column: "B" | "C";
  label: string;
}> = [
  { field: "hltWaterAmount", rowKey: "__sheetRow.water.hlt", column: "B", label: "HLT · כמות מים" },
  { field: "hltWaterTemp", rowKey: "__sheetRow.water.hlt", column: "C", label: "HLT · טמפרטורה" },
  { field: "lauterWaterAmount", rowKey: "__sheetRow.water.mashIn", column: "B", label: "MASH IN · כמות מים" },
  { field: "lauterWaterTemp", rowKey: "__sheetRow.water.mashIn", column: "C", label: "MASH IN · טמפרטורה" },
];

export function missingBrewWaterSheetCells(
  blockIndex: number,
  appFields: Readonly<Record<string, string>>,
  sheetFields: Readonly<Record<string, string>>,
): MissingBrewWaterCell[] {
  const missing: MissingBrewWaterCell[] = [];
  for (const spec of WATER_FIELDS) {
    const expected = String(appFields[spec.field] ?? "").trim();
    if (!expected || String(sheetFields[spec.field] ?? "").trim()) continue;
    const row = Number(sheetFields[spec.rowKey]);
    if (!Number.isSafeInteger(row) || row < 1 || row > 1000) continue;
    missing.push({
      blockIndex, field: spec.field, label: spec.label,
      range: `'גיליון1'!${spec.column}${row}`,
      expected,
    });
  }
  return missing;
}

/** A display-formatted value such as '62 °C' and a numeric app input 62
 * refer to the same physical measurement. Avoid loose, substring matching
 * (e.g. 62 must not accidentally match 620).
 */
export function sameBrewWaterSheetValue(actual: unknown, expected: unknown): boolean {
  const a = String(actual ?? "").trim();
  const b = String(expected ?? "").trim();
  if (a === b) return true;
  const parse = (value: string) => {
    const cleaned = value.replace(/,/g, ".").replace(/\s*(?:ליטר|ליטרים|°?C|°|℃)\s*$/gi, "").trim();
    return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
  };
  const numberA = parse(a);
  const numberB = parse(b);
  return numberA !== null && numberB !== null && numberA === numberB;
}
