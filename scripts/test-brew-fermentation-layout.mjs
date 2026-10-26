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

assert.match(read("server/updatePackagingInfo.js"), /Total litres and shrinkage are already calculated/);
const packagingRequests = [];
ctx.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
ctx.Sheets = { Spreadsheets: { batchUpdate: ({ requests }) => packagingRequests.push(...requests) } };
ctx.Logger = { log() {} };
ctx.logToSheet = () => {};
ctx.extractSpreadsheetId = () => "test-sheet";
ctx.formatMeasurementValue = (x) => x;
vm.runInContext(`getPackagingLayout_ = () => ({
  sheetId: 42, sheetName: "גיליון1",
  checkbox: { row: 60, col: 9 }, kegs: { row: 63, col: 8 },
  crates: { row: 63, col: 9 }, total: { row: 64, col: 9 },
  shrinkage: { row: 65, col: 9 }
})`, ctx);
const packagingResult = ctx.updatePackagingInfo("test-sheet", true, 20, 50, 1083, 9.5);
assert.equal(packagingRequests.length, 3, "only checkbox/kegs/crates should be written");
assert.deepEqual(
  packagingRequests.map((r) => [r.updateCells.range.startRowIndex + 1, r.updateCells.range.startColumnIndex + 1]),
  [[60,9],[63,8],[63,9]]
);
assert.equal(packagingResult.updatedTotal, false);

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
  rows[fermentationHeader][2] = "אצווה:";
  rows[fermentationHeader][5] = "מספר מיכל:";
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
// All six fermentation metadata fields are resolved by labels alone.
for (const [header, metadata, blocks] of [[56,59,1], [60,63,1], [61,64,1], [111,114,2], [160,163,3]]) {
  const sheet = sheetWithFermentation(header, metadata, blocks);
  for (const [semantic, expectedRow, column] of [
    ["fermentation.style", header + 1, 2],
    ["fermentation.batchNumber", header + 1, 4],
    ["fermentation.tankNumber", header + 1, 7],
    ["fermentation.brewDate", metadata, 2],
    ["fermentation.startingPlato", metadata, 4],
    ["fermentation.yeastPitchTime", metadata, 7],
  ]) {
    // The caller's row is intentionally wrong; only semantic identity matters.
    const mapped = ctx.brewingSheetResolveFermentationMetadataRange_(sheet, sheet.getRange(59, column), semantic);
    assert.equal(mapped.getRow(), expectedRow, semantic + " exact row");
    assert.equal(mapped.getColumn(), column, semantic + " exact column");
  }
  if (blocks === 1) {
    const row60 = ctx.brewingSheetResolveFermentationMetadataRange_(
      sheet, sheet.getRange(60, 7),
    );
    assert.equal(row60.getRow(), metadata > 60 ? metadata : 60,
      "legacy single-brew row60 alias is restricted to shifted metadata");
  }
  // The old untagged address must remain compatible ONLY for the one
  // historical fermentation row belonging to this layout. In triple brews
  // B59/B106 are real material cells and must not be redirected.
  const legacyRow = blocks === 1 ? 59 : blocks === 2 ? 106 : 156;
  for (const column of [2, 4, 7]) {
    assert.equal(ctx.brewingSheetResolveFermentationMetadataRange_(sheet, sheet.getRange(legacyRow, column)).getRow(), metadata);
    const materialRow = blocks === 3 ? 59 : blocks === 2 ? 59 : 45;
    assert.equal(ctx.brewingSheetResolveFermentationMetadataRange_(sheet, sheet.getRange(materialRow, column)).getRow(), materialRow);
  }
}
const missingLabels = sheetWithFermentation(60, 63);
missingLabels.rows[62][4] = "";
assert.throws(() => ctx.brewingSheetResolveFermentationMetadataRange_(missingLabels, missingLabels.getRange(59, 2), "fermentation.brewDate"),
  /Expected exactly one/);
assert.throws(() => ctx.brewingSheetResolveFermentationMetadataRange_(missingLabels, missingLabels.getRange(59, 2), "fermentation.badField"),
  /Unknown semantic/);
console.log("PASS: empty checkbox, label-based fermentation writes, raw A1 isolation, and packaging I-column totals");
