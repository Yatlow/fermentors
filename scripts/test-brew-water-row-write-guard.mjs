import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const source = readFileSync(new URL("../server/BREWING_SHEET_SERVICE.js", import.meta.url), "utf8");
const from = source.indexOf("function brewingSheetWriteCells_(data)");
const to = source.indexOf("function brewingSheetTemplateForType_", from);
assert.ok(from >= 0 && to > from, "the existing Apps Script writer should be tested directly");
const writerSource = source.slice(from, to);

function fixture(initialLabel = "HLT") {
  const values = { A17: initialLabel, B17: "1550", C17: "" };
  const changed = [];
  const sheet = {
    getRange(a1, column) {
      const cell = typeof a1 === "number" ? String.fromCharCode(64 + column) + a1 : a1;
      return {
        getNumRows: () => 1,
        getNumColumns: () => 1,
        getColumn: () => cell.charCodeAt(0) - 64,
        getRow: () => Number(cell.slice(1)),
        getA1Notation: () => cell,
        getDisplayValue: () => String(values[cell] ?? ""),
        setValue(value) { values[cell] = value; changed.push(cell); },
      };
    },
  };
  const context = {
    brewingSheetAssertAllowedFile_: (value) => value,
    brewingSheetResolveFermentationMetadataRange_: (_sheet, range) => range,
    brewingSheetCellValue_: (value) => value,
    brewingSheetMirrorFinalTankVolume_: () => false,
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: () => sheet,
        getSheets: () => [sheet],
      }),
      flush: () => {},
    },
  };
  vm.runInNewContext(writerSource, context);
  const write = (item) => context.brewingSheetWriteCells_({
    spreadsheetId: "test-id", writes: [item],
  });
  return { values, changed, write };
}

test("HLT C17 correction succeeds only while A17 is still HLT and the cell remains blank", () => {
  const f = fixture();
  const result = f.write({ range: "'גיליון1'!C17", value: 62, expectedValue: "", expectedRowLabel: "HLT" });
  assert.equal(result.updated, 1);
  assert.equal(f.values.C17, 62);
  const duplicate = f.write({ range: "'גיליון1'!C17", value: 63, expectedValue: "", expectedRowLabel: "HLT" });
  assert.equal(duplicate.updated, 0, "manual data cannot be silently overwritten");
  assert.equal(f.values.C17, 62);
});

test("stale row mapping refuses a write even if the old cell is empty", () => {
  const f = fixture("Other field");
  assert.throws(() => f.write({ range: "'גיליון1'!C17", value: 62,
    expectedValue: "", expectedRowLabel: "HLT" }), /Water row mapping changed/);
  assert.equal(f.values.C17, "");
  assert.deepEqual(f.changed, []);
});

test("only single-cell B/C targets and supported HLT/MASH IN row labels can be repaired", () => {
  const f = fixture();
  assert.throws(() => f.write({ range: "'גיליון1'!D17", value: 62,
    expectedRowLabel: "HLT" }), /column B or C/);
  assert.throws(() => f.write({ range: "'גיליון1'!C17", value: 62,
    expectedRowLabel: "unknown" }), /Unsupported water-row/);
  assert.deepEqual(f.changed, []);
});
