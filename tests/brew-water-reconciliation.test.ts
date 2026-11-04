import assert from "node:assert/strict";
import { test } from "node:test";
import {
  missingBrewWaterSheetCells,
  sameBrewWaterSheetValue,
} from "../src/SERVICES/brewing/brewWaterReconciliation";

test("batch 1614 A: HLT 62 in app but empty C17 in Sheet must trigger a repair warning", () => {
  const app = { hltWaterAmount: "1550", hltWaterTemp: "62",
    lauterWaterAmount: "850", lauterWaterTemp: "67.1" };
  const pulled = {
    "__sheetRow.water.hlt": "17",
    "__sheetRow.water.mashIn": "18",
    hltWaterAmount: "1550",
    lauterWaterAmount: "850",
    lauterWaterTemp: "67.1",
  };
  assert.deepEqual(missingBrewWaterSheetCells(1, app, pulled), [{
    blockIndex: 1, field: "hltWaterTemp", label: "HLT · טמפרטורה",
    range: "'גיליון1'!C17", expected: "62",
  }]);
});

test("detects missing HLT and mash-in values separately for A/B/C without guessing rows", () => {
  const app = { hltWaterAmount: "1550", hltWaterTemp: "62",
    lauterWaterAmount: "850", lauterWaterTemp: "67.1" };
  const pulled = {
    "__sheetRow.water.hlt": "107",
    "__sheetRow.water.mashIn": "108",
  };
  const result = missingBrewWaterSheetCells(3, app, pulled);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map((item) => item.range),
    ["'גיליון1'!B107", "'גיליון1'!C107", "'גיליון1'!B108", "'גיליון1'!C108"]);
  assert.ok(result.every((item) => item.blockIndex === 3));
});

test("never repairs a populated cell (even if it conflicts) or a field without mapped row", () => {
  const app = { hltWaterTemp: "62", lauterWaterTemp: "67.1" };
  assert.deepEqual(missingBrewWaterSheetCells(1, app, {
    "__sheetRow.water.hlt": "17", hltWaterTemp: "65",
    "__sheetRow.water.mashIn": "18", lauterWaterTemp: "67.1",
  }), []);
  assert.deepEqual(missingBrewWaterSheetCells(1, app, {
    "__sheetRow.water.hlt": "garbled", "__sheetRow.water.mashIn": "0",
  }), []);
  assert.deepEqual(missingBrewWaterSheetCells(1, {}, {
    "__sheetRow.water.hlt": "17",
  }), []);
});

test("water cell verification uses exact values, with only explicit numeric unit formatting", () => {
  for (const [a,b] of [["62", "62"],["62 °C", "62"],["1550 ליטר", "1550"],["67,1", "67.1"]]) {
    assert.equal(sameBrewWaterSheetValue(a,b), true, a + " vs " + b);
  }
  assert.equal(sameBrewWaterSheetValue("620", "62"), false);
  assert.equal(sameBrewWaterSheetValue("notes 62", "62"), false);
  assert.equal(sameBrewWaterSheetValue("", "62"), false);
});
