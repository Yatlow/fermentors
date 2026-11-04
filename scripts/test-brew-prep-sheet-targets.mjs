import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/brewing/brewPrepSheetMapping.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { resolveBrewPrepSheetTargets: resolve } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

function brewSheet() {
  // Based on the live structure of IPA triple brew #1615 on 2026-11-04.
  // Keep real sheet row numbers (1-based) to catch A/B/C cross-writes.
  const rows = Array.from({ length: 205 }, () => Array(8).fill(""));
  rows[0][4] = "אצווה:"; rows[0][5] = "1615"; // generic file heading is NOT a brew block
  for (const [head, hlt, mash, letter] of [
    [4, 17, 18, "A"], [54, 67, 68, "B"], [104, 117, 118, "C"],
  ]) {
    rows[head - 1][1] = "סוג:";
    rows[head - 1][3] = "אצווה:";
    rows[head - 1][4] = "1615" + letter;
    rows[hlt - 1][0] = "HLT";
    rows[mash - 1][0] = "MASH IN";
  }
  rows[16][1] = "1500";
  rows[16][2] = "67";
  rows[17][1] = "1040";
  rows[17][2] = "54.5";
  rows[155][0] = "יום בישול ";
  rows[155][2] = "סוכר תחילי";
  rows[155][4] = "שעת הוספת שמרים";
  return rows;
}

test("batch 1615 A water and date map to exact live labels, not stale offsets", () => {
  const rows = brewSheet();
  assert.deepEqual(resolve(rows, 1615, 1, "water"), {
    headerRow: 4, hltRow: 17, mashWaterRow: 18, fermentationRow: 156,
  });
  assert.deepEqual(resolve(rows, "1615", 1, "date"), {
    headerRow: 4, hltRow: 17, mashWaterRow: 18, fermentationRow: 156,
  });
  assert.notEqual(resolve(rows, 1615, 1, "water").hltRow, 16);
});

test("triple-brew B and C never write to A or the fermentation table", () => {
  const rows = brewSheet();
  assert.deepEqual(resolve(rows, 1615, 2, "water"), {
    headerRow: 54, hltRow: 67, mashWaterRow: 68, fermentationRow: 156,
  });
  assert.deepEqual(resolve(rows, 1615, 3, "water"), {
    headerRow: 104, hltRow: 117, mashWaterRow: 118, fermentationRow: 156,
  });
  // Physical row shifts (3-rest layout) are discovered rather than predicted.
  rows[16][0] = "";
  rows[17][0] = "";
  rows[19][0] = "HLT"; rows[20][0] = "MASH IN";
  assert.equal(resolve(rows, 1615, 1, "water").hltRow, 20);
  assert.equal(resolve(rows, 1615, 1, "water").mashWaterRow, 21);
});

test("fail closed on wrong batch, duplicate or unlabelled water rows", () => {
  const rows = brewSheet();
  assert.throws(() => resolve(rows, 1614, 1, "water"), /כותרת ייחודית/);
  rows[15][0] = "HLT";
  assert.throws(() => resolve(rows, 1615, 1, "water"), /מיפוי המים/);
  rows[15][0] = "";
  rows[16][0] = "";
  assert.throws(() => resolve(rows, 1615, 1, "water"), /מיפוי המים/);
  rows[16][0] = "HLT";
  rows[155][0] = "";
  assert.throws(() => resolve(rows, 1615, 1, "date"), /יום בישול/);
  assert.equal(resolve(rows, 1615, 2, "date").headerRow, 54,
    "B's own header can be written without assuming a global fermentation date");
});

test("on-demand metadata discovery does not replace live form inputs", () => {
  const form = readFileSync(new URL("../src/components/brewing/BrewFormStepper.tsx", import.meta.url), "utf8");
  const helper = form.slice(form.indexOf("async function ensureLiveBrewPrepRows("), form.indexOf("function mappedFermentationRow("));
  assert.match(helper, /serverReadBrewSheetRange\(sheetId/);
  assert.match(helper, /if \(!sheetId\) throw new Error/);
  assert.match(helper, /resolveBrewPrepSheetTargets\(/);
  assert.match(helper, /fields: nextFields/);
  assert.doesNotMatch(helper, /readBrewSheetRange\(run\.sheetId/);
  assert.doesNotMatch(helper, /replaceBrewingExecutionBlockFields/);
  const waterCommit = form.slice(form.indexOf("async function commitWaterField("), form.indexOf("async function commitPh(", form.indexOf("async function commitWaterField(")));
  assert.match(waterCommit, /await ensureLiveBrewPrepRows\(waterBlock, "water"\)/);
  assert.match(waterCommit, /expectedRowLabel: target\.source === "hlt" \? "HLT" : "MASH IN"/);
  const dateCommit = form.slice(form.indexOf("async function commitBrewDate("), form.indexOf("async function confirmMaterials(", form.indexOf("async function commitBrewDate(")));
  assert.ok(dateCommit.indexOf("setExecution((previous)") < dateCommit.indexOf("await ensureLiveBrewPrepRows(dateBlock, \"date\")"),
    "date must commit before async Sheet mapping");
  assert.match(dateCommit, /semanticField: "fermentation\.brewDate"/);
  assert.match(dateCommit, /range: "'גיליון1'!H1"/);
  const genericCommit = form.slice(form.indexOf("async function commit("), form.indexOf("function localValue(", form.indexOf("async function commit(")));
  assert.match(genericCommit, /setExecution\(\(previous\) =>/);
});
