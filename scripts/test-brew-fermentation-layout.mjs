import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const ctx = {
  SpreadsheetApp: { DataValidationCriteria: { CHECKBOX: "CHECKBOX" } },
  CacheService: { getScriptCache: () => ({ put() {} }) },
  console,
};
vm.createContext(ctx);
vm.runInContext(read("server/updatePackagingInfo.js"), ctx);
vm.runInContext(read("server/BREWING_SHEET_SERVICE.js"), ctx);

const reference = { row: 63, col: 7 }; // H64: zero-based row+column
assert.deepEqual(JSON.parse(JSON.stringify(ctx.packagingTargetLeftOfLabel_(reference))), { row: 64, col: 9 });
assert.equal(ctx.packagingTargetBelowLabel_({ row: 61, col: 7 }).col, 8);
assert.equal(ctx.packagingTargetBelowLabel_({ row: 61, col: 8 }).col, 9);
assert.match(read("server/updatePackagingInfo.js"), /packaging_layout:v2:/);
assert.doesNotMatch(read("server/updatePackagingInfo.js"), /"packaging_layout:" \+ spreadsheetId/);

// Emulate the precise A:I sheet geometry without mutating any production Sheet.
function sheetWithFermentation(fermentationHeader, metaRow, blocks = 1) {
  const rows = Array.from({ length: metaRow + 3 }, () => Array(9).fill(""));
  for (let k = 0; k < blocks; k++) {
    const i = k === 0 ? 3 : k === 1 ? 53 : 101;
    rows[i][1] = "סוג:";
    rows[i][3] = "אצווה:";
  }
  rows[fermentationHeader - 1][0] = "דף תסיסה";
  rows[fermentationHeader - 1][7] = "סיכום אריזה";
  rows[metaRow - 1][0] = "יום בישול ";
  rows[metaRow - 1][2] = "סוכר תחילי";
  rows[metaRow - 1][4] = "שעת הוספת שמרים";
  const validations = new Map();
  const sheet = {
    rows,
    getDataRange: () => ({ getDisplayValues: () => rows }),
    getRange: (row, col) => ({
      getColumn: () => col,
      getRow: () => row,
      getNumRows: () => 1,
      getNumColumns: () => 1,
      getA1Notation: () => String.fromCharCode(64 + col) + row,
      getDisplayValue: () => String(rows[row - 1][col - 1] ?? ""),
      setValue: (value) => { rows[row - 1][col - 1] = value; },
      getDataValidation: () => validations.get(row + ":" + col) ?? null,
      insertCheckboxes: () => { validations.set(row + ":" + col, { getCriteriaType: () => "CHECKBOX" }); },
      copyFormatToRange: () => {}
    }),
  };
  return sheet;
}
for (const [header, metadata] of [[56,59], [60,63], [61,64], [160,168]]) {
  const sheet = sheetWithFermentation(header, metadata);
  assert.equal(ctx.brewingSheetEnsureEmptyCheckbox_(sheet), true);
  assert.equal(sheet.rows[header - 2][7], "ריק?:");
  assert.equal(sheet.rows[header - 2][8], false);
  assert.equal(ctx.brewingSheetEnsureEmptyCheckbox_(sheet), false);
  assert.equal(sheet.rows[metadata - 1][0], "יום בישול ");
}
// A third mash rest shifts fermentation metadata. The known one-row legacy
// alias B/D/G60 must resolve only when the actual metadata row is after 60.
for (const [metadata, from] of [[63,59], [63,60], [64,59], [64,60]]) {
  const sheet = sheetWithFermentation(metadata - 3, metadata);
  for (const column of [2,4,7]) {
    const original = sheet.getRange(from, column);
    const mapped = ctx.brewingSheetResolveFermentationMetadataRange_(sheet, original);
    assert.equal(mapped.getRow(), metadata, "single brew legacy metadata row");
  }
}
const normal = sheetWithFermentation(56, 59);
assert.equal(ctx.brewingSheetResolveFermentationMetadataRange_(normal, normal.getRange(60, 7)).getRow(), 60);
const triple = sheetWithFermentation(160, 168, 3);
assert.equal(ctx.brewingSheetResolveFermentationMetadataRange_(triple, triple.getRange(156, 2)).getRow(), 168);
assert.equal(ctx.brewingSheetResolveFermentationMetadataRange_(triple, triple.getRange(59, 2)).getRow(), 59);
console.log("PASS: checkbox creation, shifted semantic metadata, and packaging columns (G untouched)");
