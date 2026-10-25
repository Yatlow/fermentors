import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBrewMaterialSheetWrites,
  type MaterialSheetWriteIntent,
} from "../src/SERVICES/brewing/materialSheetWriteMapping.ts";

function wheat1610Sheet(): (string | null)[][] {
  const rows = Array.from({ length: 116 }, () => Array<string | null>(8).fill(null));
  const add = (number: number, contents: Record<number, string>) => {
    Object.entries(contents).forEach(([column, value]) => { rows[number - 1][Number(column)] = value; });
  };
  add(1, { 0: "סוג:", 1: "חיטה", 2: "מס' מיכל:", 3: "7", 4: "אצווה:", 5: "1610" });
  add(4, { 1: "סוג:", 2: "חיטה כפול", 3: "אצווה:", 4: "1610A" });
  add(9, { 0: "100.0Kg", 1: "Pilsner #217205", 3: "הכנסת לתת" });
  add(10, { 0: "112.5Kg", 1: "Wheat #212326" });
  add(11, { 0: "16.5Kg", 1: "CH #B324", 3: "השריה 1" });
  add(27, { 0: "כמות", 1: "אחוז אלפה", 2: "סוג/אצווה" });
  add(28, { 0: "0g", 1: "14", 2: "1)Magnum #1001847" });
  add(34, { 0: "שמרים", 3: "שטיפה 4" });
  add(35, { 0: "כמות", 1: "סוג", 2: "אצווה/ מקור" });
  add(58, { 1: "סוג:", 2: "חיטה כפול", 3: "אצווה:", 4: "1610B" });
  add(63, { 0: "100.0Kg", 1: "Pilsner #217205", 3: "הכנסת לתת" });
  add(64, { 0: "112.5Kg", 1: "Wheat #212326" });
  add(65, { 0: "16.5Kg", 1: "CH #B324", 3: "השריה 1" });
  add(81, { 0: "כמות", 1: "אחוז אלפה", 2: "סוג/אצווה" });
  add(82, { 0: "0g", 1: "14", 2: "1)Magnum #1001847" });
  add(88, { 0: "שמרים", 3: "שטיפה 4" });
  add(89, { 0: "כמות", 1: "סוג", 2: "אצווה/ מקור" });
  return rows;
}

const grain = (rowOffset: number): MaterialSheetWriteIntent => ({
  rowKey: "__sheetRow.stage.mashIn", rowOffset, column: "B", value: "verified-lot",
});
const hop: MaterialSheetWriteIntent = {
  rowKey: "__sheetRow.rawHop.1", rowOffset: 0, column: "C", value: "1)Magnum #1001847",
};
const yeast: MaterialSheetWriteIntent = {
  rowKey: "__sheetRow.material.yeast", rowOffset: 0, column: "B", value: "yeast lot 123",
};

test("1610 wheat A maps grains, hop and yeast data, NEVER the yeast headings", () => {
  const result = resolveBrewMaterialSheetWrites(wheat1610Sheet(), "1610", 1,
    [grain(0), grain(1), grain(2), hop, yeast]);
  assert.deepEqual(result.writes.map((w) => w.range), [
    "'גיליון1'!B9", "'גיליון1'!B10", "'גיליון1'!B11",
    "'גיליון1'!C28", "'גיליון1'!B36",
  ]);
  assert.equal(result.metadata["__sheetRow.material.yeast"], "36");
  assert.ok(!result.writes.some((w) => w.range.endsWith("35")));
});

test("1610 wheat B uses its own positions, even if A has the same labels", () => {
  const result = resolveBrewMaterialSheetWrites(wheat1610Sheet(), "1610", 2,
    [grain(0), grain(2), hop]);
  assert.deepEqual(result.writes.map((w) => w.range), [
    "'גיליון1'!B63", "'גיליון1'!B65", "'גיליון1'!C82",
  ]);
});

test("missing stage never guesses a row; Firestore can remain approved", () => {
  const rows = wheat1610Sheet();
  rows[8][3] = null;
  assert.throws(() => resolveBrewMaterialSheetWrites(rows, "1610", 1, [grain(0)]),
    /__sheetRow.stage.mashIn/);
});

test("wrong batch and ambiguous A headers fail closed instead of writing to B", () => {
  assert.throws(() => resolveBrewMaterialSheetWrites(wheat1610Sheet(), "1611", 1, [grain(0)]),
    /1611A/);
  const rows = wheat1610Sheet();
  rows[57][4] = "1610A";
  assert.throws(() => resolveBrewMaterialSheetWrites(rows, "1610", 1, [grain(0)]),
    /כותרת יחידה/);
});

test("missing hop section never borrows the other brew's hop row", () => {
  const rows = wheat1610Sheet();
  rows[80][1] = "INVALID";
  assert.throws(() => resolveBrewMaterialSheetWrites(rows, "1610", 2, [hop]),
    /__sheetRow.rawHop.1/);
});

test("legacy layout without an intervening yeast header can still be located safely", () => {
  const rows = wheat1610Sheet();
  rows[34] = [null, null, null, null, null, null, null, null];
  const result = resolveBrewMaterialSheetWrites(rows, "1610", 1, [yeast]);
  assert.equal(result.writes[0].range, "'גיליון1'!B35");
});

test("a missing semantic yeast section fails closed", () => {
  const rows = wheat1610Sheet();
  rows[33][0] = null;
  assert.throws(() => resolveBrewMaterialSheetWrites(rows, "1610", 1, [yeast]),
    /__sheetRow.material.yeast/);
});
