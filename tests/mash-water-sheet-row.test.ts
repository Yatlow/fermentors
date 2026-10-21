import test from "node:test";
import assert from "node:assert/strict";
import { mashWaterFromSheetRow } from "../src/SERVICES/brewing/mashWaterSheetRow";

test("recovers A/B/C MASH IN water amounts and temperature from semantic Sheet row", () => {
  assert.deepEqual(mashWaterFromSheetRow("850", "77.5", ""), { amount: "850", temperature: "77.5" });
  assert.deepEqual(mashWaterFromSheetRow("850 ליטר", "76,5°C", ""), { amount: "850", temperature: "76.5" });
  assert.deepEqual(mashWaterFromSheetRow("", "75", "850"), { amount: "850", temperature: "75" });
});

test("does not infer false temperatures from an empty, shifted or malformed Sheet cell", () => {
  assert.deepEqual(mashWaterFromSheetRow("850", "", "77"), { amount: "850", temperature: "" });
  assert.deepEqual(mashWaterFromSheetRow("850", "190", ""), { amount: "850", temperature: "" });
  assert.deepEqual(mashWaterFromSheetRow("", "", ""), { amount: "", temperature: "" });
});
