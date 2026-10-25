/**
 * Resolve raw-material Sheet writes against the current, identifiable A/B/C
 * section of the actual workbook. Never fall back to an absolute row number:
 * Wheat and other multi-rest recipes move the process rows independently.
 *
 * Pure by design, so live workbook layouts can be regression-tested without
 * touching Firestore or Google Sheets.
 */
export type MaterialSheetWriteIntent = {
  rowKey: string;
  rowOffset: number;
  column: "A" | "B" | "C";
  value: string | number | boolean | null;
};

export type MaterialSheetWrite = {
  range: string;
  value: string | number | boolean | null;
};

const cell = (row: readonly unknown[], index: number) =>
  String(row[index] ?? "").trim();

function isBrewHeader(row: readonly unknown[]): boolean {
  return row.some((value) => /^(?:סוג(?:\s+בירה)?|סגנון)\s*:?$/i.test(String(value ?? "").trim())) &&
    row.some((value) => /^אצווה\s*:?$/i.test(String(value ?? "").trim())) &&
    row.some((value) => /^\d{3,6}\s*[ABC]$/i.test(String(value ?? "").trim()));
}

function brewSuffix(row: readonly unknown[]): string | null {
  const candidate = row.find((value) => /^\d{3,6}\s*[ABC]$/i.test(String(value ?? "").trim()));
  return candidate == null ? null : String(candidate).replace(/\s+/g, "").toUpperCase();
}

export function resolveBrewMaterialSheetWrites(
  rows: readonly (readonly unknown[])[],
  batchNumber: string,
  blockIndex: number,
  intents: readonly MaterialSheetWriteIntent[],
): { writes: MaterialSheetWrite[]; metadata: Record<string, string> } {
  if (!Number.isInteger(blockIndex) || blockIndex < 1 || blockIndex > 3) {
    throw new Error("מספר בישול לא תקין למיפוי חומרי גלם.");
  }
  const desired = String(batchNumber).trim() + String.fromCharCode(64 + blockIndex);
  const headers = rows.flatMap((row, index) =>
    isBrewHeader(row) ? [{ index, suffix: brewSuffix(row) }] : []);
  const matching = headers.filter(({ suffix }) => suffix === desired);
  if (matching.length !== 1) {
    throw new Error(`לא נמצאה כותרת יחידה לבישול ${desired} בגיליון. העדכון ל-Sheet לא בוצע.`);
  }
  const start = matching[0].index;
  const end = headers.find(({ index }) => index > start)?.index ?? rows.length;
  const find = (predicate: (row: readonly unknown[]) => boolean) => {
    for (let index = start + 1; index < end; index += 1) {
      if (predicate(rows[index] || [])) return index;
    }
    return -1;
  };
  const metadata: Record<string, string> = {};
  const mashIndex = find((row) => /^הכנסת לתת$/i.test(cell(row, 3)));
  if (mashIndex >= 0) metadata["__sheetRow.stage.mashIn"] = String(mashIndex + 1);

  const hopHeader = find((row) =>
    /^כמות$/i.test(cell(row, 0)) &&
    /אחוז.*אלפ/i.test(cell(row, 1)) &&
    /^סוג\s*\/\s*אצווה$/i.test(cell(row, 2)));
  if (hopHeader >= 0) {
    for (let index = 1; index <= 5 && hopHeader + index < end; index += 1) {
      metadata[`__sheetRow.rawHop.${index}`] = String(hopHeader + index + 1);
    }
  }

  const yeastHeading = find((row) => /^שמרים$/i.test(cell(row, 0)));
  if (yeastHeading >= 0) {
    const following = rows[yeastHeading + 1] || [];
    // In current brew templates the heading is followed by column labels,
    // then the actual ingredient row. Never overwrite the labels.
    const containsColumnLabels = /^כמות$/i.test(cell(following, 0)) &&
      /^סוג$/i.test(cell(following, 1));
    const yeastRow = yeastHeading + (containsColumnLabels ? 2 : 1);
    if (yeastRow < end) {
      metadata["__sheetRow.material.yeast"] = String(yeastRow + 1);
    }
  }

  // Validate ALL coordinates before starting the batch update. One missing
  // semantic label must never cause a partially guessed Sheet write.
  const writes = intents.map(({ rowKey, rowOffset, column, value }) => {
    const base = Number(metadata[rowKey]);
    if (!Number.isInteger(base) || base <= 0 ||
        !Number.isInteger(rowOffset) || rowOffset < 0 || rowOffset > 5 ||
        !["A", "B", "C"].includes(column) ||
        base + rowOffset > end) {
      throw new Error(`חסר מיפוי סמנטי תקין עבור ${rowKey} בבישול ${desired}. לא בוצעה כתיבה משוערת לגיליון.`);
    }
    return { range: `'גיליון1'!${column}${base + rowOffset}`, value };
  });
  return { writes, metadata };
}
