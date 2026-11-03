import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// Execute the actual Apps Script stage extractor with a synthetic Sheet.
const stageSource = read("../server/extractBrewStageInfo.js");
const sheet = { values: [] };
const ctx = {
  console,
  Date,
  Logger: { log() {} },
  extractSpreadsheetId: (id) => id,
  SpreadsheetApp: { openById: () => ({
    getSheets: () => [{ getDataRange: () => ({ getDisplayValues: () => sheet.values }) }],
  }) },
};
vm.createContext(ctx);
vm.runInContext(stageSource, ctx, { filename: "extractBrewStageInfo.js" });

function brewSheet(blocks) {
  const rows = Array.from({ length: 8 + blocks.length * 14 }, () => Array(9).fill(""));
  rows[0][6] = "תאריך:";
  rows[0][7] = "10/10/2026";
  blocks.forEach((block, i) => {
    const offset = 2 + 14 * i;
    rows[offset][0] = "סוג:";
    rows[offset][1] = "IPA";
    rows[offset][2] = "אצווה:";
    rows[offset][3] = "#1600";
    rows[offset][4] = "תאריך";
    rows[offset][5] = block.date ?? "";
    rows[offset + 1][0] = "פעולה";
    rows[offset + 1][1] = "ש. התחלה";
    rows[offset + 1][2] = "ש. סיום";
    rows[offset + 2][0] = "הוצאה לתסיסה";
    rows[offset + 2][1] = block.start ?? "";
    rows[offset + 2][2] = block.end ?? "";
  });
  rows[rows.length - 1][0] = "דף תסיסה";
  return rows;
}

function extract(blocks) {
  sheet.values = brewSheet(blocks);
  return ctx.extractBrewStageInfo("test-sheet", {
    tankNumber: 8,
    batchNumber: "1600",
    brewDate: "10/10/2026",
  }).transferCompletedAt;
}

function localStamp(iso) {
  const date = new Date(iso);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
}
assert.deepEqual(localStamp(extract([
  { date: "10/10/2026", start: "23:50", end: "00:20" },
])), [2026, 10, 11, 0, 20], "a reported end after midnight belongs to the following day");
assert.deepEqual(localStamp(extract([
  { date: "10/10/2026", start: "09:00", end: "10:00" },
  { date: "11/10/2026", start: "09:00", end: "11:00" },
])), [2026, 10, 11, 11, 0], "double brew grace starts at B, not A or ACTION-1");
assert.deepEqual(localStamp(extract([
  { date: "10/10/2026", start: "09:00", end: "10:00" },
  { date: "11/10/2026", start: "09:00", end: "10:30" },
  { date: "12/10/2026", start: "23:55", end: "00:30" },
])), [2026, 10, 13, 0, 30], "triple brew grace starts when C transfer really ends");
assert.equal(extract([
  { date: "10/10/2026", start: "09:00", end: "10:00" },
  { date: "11/10/2026", start: "09:00", end: "11:00" },
  { date: "12/10/2026", start: "09:00", end: "" },
]), null, "A/B completion must not start final C grace");
assert.equal(extract([
  { date: "10/10/2026", start: "09:00", end: "10:00" },
  { date: "", start: "09:00", end: "11:00" },
]), null, "missing B date must not be inferred from A when both start at the same hour");
assert.equal(extract([
  { date: "10/10/2026", start: "", end: "10:00" },
]), null, "an end time without an established process row is not a safe anchor");

const source = read("../src/SERVICES/dashboard/cellarGrace.ts");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const grace = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

const oldDetection = new Date(2026, 9, 11, 13, 0);
const actualFinish = new Date(2026, 9, 11, 10, 30);
const tank = {
  id: "8", tankNumber: 8, batchNumber: "1600", action: 1,
  fermentationStartedAt: oldDetection.toISOString(),
  fermentationTransferCompletedAt: actualFinish.toISOString(),
  fermentationTransferBatchNumber: "1600",
};
assert.equal(grace.fermentationGraceStart(tank, new Date(2026, 9, 11, 15)), actualFinish.getTime());
assert.equal(grace.fermentationGraceEnd(tank, new Date(2026, 9, 11, 15)),
  actualFinish.getTime() + 12 * 3600_000,
  "12h start from actual transfer end, regardless of the later entry");
assert.equal(grace.isInInitialMeasurementGrace(tank, new Date(2026, 9, 11, 22, 29)), true);
assert.equal(grace.isInInitialMeasurementGrace(tank, new Date(2026, 9, 11, 22, 30)), false);
assert.equal(grace.elapsedFermentationHours(tank, new Date(2026, 9, 11, 12)), "01:30");
const withoutTime = { ...tank, fermentationTransferCompletedAt: null };
assert.equal(grace.fermentationGraceStart(withoutTime), oldDetection.getTime(),
  "until the last transfer is reported, preserve ACTION-1 detection fallback");
const otherBatch = { ...tank, batchNumber: "1601" };
assert.equal(grace.fermentationGraceStart(otherBatch), oldDetection.getTime(),
  "old transfer end must not leak into a newly assigned brew");
const futureFinish = new Date(2026, 9, 11, 18);
const future = { ...tank, fermentationTransferCompletedAt: futureFinish.toISOString() };
assert.equal(grace.fermentationGraceStart(future, new Date(2026, 9, 11, 17)), oldDetection.getTime(),
  "future transfer end must not prematurely reset the clock");
assert.equal(grace.fermentationGraceStart(future, new Date(2026, 9, 11, 18)), futureFinish.getTime(),
  "when a future reported end is reached, the new clock takes effect");

// Confirm the unchanged conditional extension rule still requires completed
// veteran measurements and still stops at the following 04:00 boundary.
const veterans = [2, 3].map(n => ({
  id: String(n), tankNumber: n, action: 1,
  stage: { name: "בתסיסה" }, currentData: { temp: 17 },
  fermentationStartedAt: new Date(2026, 9, 9, 8).toISOString(),
}));
const young = { ...tank, fermentationTransferCompletedAt: new Date(2026, 9, 11, 8).toISOString() };
const fields = { "2": { temp: true, pressure: true, plato: true, pH: true },
                 "3": { temp: true, pressure: true, plato: true, pH: true } };
const active = (at, checked = fields) => grace.measurementGraceTankIds(
  [...veterans, young], checked, at,
).has("8");
assert.equal(active(new Date(2026, 9, 11, 19, 59), {}), true, "initial 12h is unconditional");
assert.equal(active(new Date(2026, 9, 11, 21), fields), true, "veterans extend after 12h");
assert.equal(active(new Date(2026, 9, 11, 21), {}), false, "incomplete veterans cancel extension");
assert.equal(active(new Date(2026, 9, 12, 3, 59), fields), true, "extension lasts until 04:00");
assert.equal(active(new Date(2026, 9, 12, 4), fields), false, "04:00 reset preserved");

// Structural regression for the existing five-minute, one-read sync.
const cycle = read("../server/fermentor-cycle-optimization.js");
assert.match(cycle, /extractBrewStageInfo\(sheetUrl, entry\.data\)/,
  "the next Sheet revision must publish the transfer timestamp to the fermentor");
assert.match(cycle, /fermentationTransferBatchNumber: String\(brew\.batchNumber/,
  "anchor must be tagged with batch identity");
assert.match(cycle, /FC_SHEET_REVISION_PREFIX_ = "fc_sheet_revision_v5:"/,
  "a one-time backfill must include already-entered transfer end times");
const action = read("../server/BREW_ACTION_SERVICE.js");
assert.match(action, /"fermentationTransferCompletedAt",\s*"fermentationTransferBatchNumber"/,
  "ACTION-5 must not carry the previous brew's transfer timestamp");
assert.match(action, /updateFermentorAction\(\s*tankNumber,\s*1,\s*true\s*\)/,
  "ACTION 0 -> 1 remains unchanged");

console.log("Final A/B/C transfer grace anchors, late reporting, midnight, old-batch guard and 04:00 extension passed");
