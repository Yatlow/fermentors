import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/brewing/brewSheetTimeRecovery.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { planMissingMashTimeSheetWrites: plan, normalizedBrewSheetTime } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("IPA triple brew 1615: only genuinely missing mash hours are recovered", () => {
  const actual = plan([{
    blockIndex: 1,
    appFields: {
      "mashIn.start": "09:54", "mashIn.end": "10:21", "rest1.start": "10:28",
      "rest1.end": "", "rest2.start": "HH:MM",
    },
    sheetFields: {
      "__sheetRow.stage.mashIn": "9",
      "__sheetRow.stage.rest1": "11",
      "__sheetRow.stage.rest2": "15",
      "__sheetRow.fermentation": "153",
      "mashIn.start": "09:54", "mashIn.end": "", "rest1.start": "",
    },
  }]);
  assert.deepEqual(actual, [
    { blockIndex: 1, fieldKey: "mashIn.end", range: "'גיליון1'!F9", value: "10:21", expectedValue: "" },
    { blockIndex: 1, fieldKey: "rest1.start", range: "'גיליון1'!E11", value: "10:28", expectedValue: "" },
  ]);
});

test("never overwrite Sheet hours, use fallback offsets, or write into fermentation", () => {
  assert.deepEqual(plan([
    {
      blockIndex: 2,
      appFields: {
        "mashIn.end": "10:45", "rest1.start": "11:00", "rest1.end": "11:30",
        "heat1.start": "11:32", "heat2.end": "12:00",
      },
      sheetFields: {
        "__sheetRow.stage.mashIn": "59",
        "__sheetRow.stage.rest1": "61",
        "__sheetRow.stage.heat1": "63",
        "__sheetRow.stage.heat2": "210",
        "__sheetRow.fermentation": "153",
        "mashIn.end": "10:44",
        "rest1.start": "11:00",
      },
    },
  ]), [
    { blockIndex: 2, fieldKey: "rest1.end", range: "'גיליון1'!F61", value: "11:30", expectedValue: "" },
    { blockIndex: 2, fieldKey: "heat1.start", range: "'גיליון1'!E63", value: "11:32", expectedValue: "" },
  ]);
  assert.deepEqual(plan([
    { blockIndex: 1, appFields: { "rest2.start": "09:00" }, sheetFields: {} },
  ]), []);
  assert.deepEqual(plan([
    { blockIndex: 1, appFields: { "mashIn.end": "25:90", "rest1.start": "nope" },
      sheetFields: { "__sheetRow.stage.mashIn": "9", "__sheetRow.stage.rest1": "11" } },
  ]), []);
});

test("triple block repairs retain independent A/B/C semantic addresses", () => {
  const blocks = [9, 59, 106].map((row, index) => ({
    blockIndex: index + 1,
    appFields: { "mashIn.end": "10:25" },
    sheetFields: { "__sheetRow.stage.mashIn": String(row), "__sheetRow.fermentation": "153" },
  }));
  const result = plan(blocks);
  assert.deepEqual(result.map((item) => item.range), [
    "'גיליון1'!F9", "'גיליון1'!F59", "'גיליון1'!F106",
  ]);
  assert.ok(result.every((item) => item.expectedValue === ""));
});

test("startup schedules guarded repair, and never updates timestamps by forced Sheet overwrite", () => {
  const form = readFileSync(new URL("../src/components/brewing/BrewFormStepper.tsx", import.meta.url), "utf8");
  assert.match(form, /validatedSemanticBlocks && mashRecoveryBlocks.length > 0/);
  assert.match(form, /planMissingMashTimeSheetWrites\(mashRecoveryBlocks\)/);
  assert.match(form, /missingMashWrites.map\(\(\{ range, value, expectedValue \}\) => \(\{ range, value, expectedValue \}\)\)/);
  assert.match(form, /pendingSheetWrites.current.add\(write\)/);
  assert.match(form, /setSyncError\(`שעות מאש חסרות ב-Sheet ולא הושלמו אוטומטית:/);
});

test("HH:MM Sheet comparison keeps minutes distinct while accepting unpadded hours", () => {
  assert.equal(normalizedBrewSheetTime("9:54"), "09:54");
  assert.equal(normalizedBrewSheetTime("09:54"), "09:54");
  assert.equal(normalizedBrewSheetTime("10:21"), "10:21");
  assert.equal(normalizedBrewSheetTime("10:28"), "10:28");
  assert.notEqual(normalizedBrewSheetTime("10:21"), normalizedBrewSheetTime("10:28"));
  assert.equal(normalizedBrewSheetTime("11:90"), null);
  const sheetWriter = readFileSync(new URL("../src/SERVICES/brewing/brewSheet.ts", import.meta.url), "utf8");
  assert.match(sheetWriter, /const time = normalizedBrewSheetTime\(text\);/);
  assert.match(sheetWriter, /if \(time !== null\) return `#time:\$\{time\}`;/);
});
