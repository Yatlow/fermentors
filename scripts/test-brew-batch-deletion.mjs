import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const source = read("../src/SERVICES/brewing/brewDeletionPolicy.ts");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { batchDeletionBlockReason: reason } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
const tank = (action = 0, extra = {}) => ({
  id: "tank-4",
  batchNumber: "1601",
  action,
  brewProgress: null,
  ...extra,
});

test("unstarted assigned batch may be deleted and recreated", () => {
  assert.equal(reason("1601", [tank()], false, "tank-4"), null);
  assert.equal(reason("#1601", [tank()], false, "tank-4"), null);
});
test("a truly pending batch may be deleted", () => {
  assert.equal(reason("1601", [tank(5, { batchNumber: "1600" })], false), null);
});
test("pending deletion is blocked if another device already assigned the batch", () => {
  assert.match(reason("1601", [tank()], false), /משובצת/);
});
test("assigned batch must still belong to the expected tank", () => {
  assert.match(reason("1601", [tank(0, { id: "tank-9" })], false, "tank-4"), /השתנה/);
});
test("started fermentation blocks batch deletion", () => {
  assert.match(reason("1601", [tank(1)], false, "tank-4"), /הבישול כבר התחיל/);
});
test("reported brewing step blocks deletion even if action still zero", () => {
  assert.match(reason("1601", [tank(0, { brewProgress: { stageName: "מאש" } })], false, "tank-4"), /הבישול כבר התחיל/);
});
test("measurements block deletion in all states", () => {
  assert.match(reason("1601", [], true), /מדידות/);
  assert.match(reason("1601", [tank()], true, "tank-4"), /מדידות/);
});
test("duplicate active tank assignments must not be deleted", () => {
  assert.match(reason("1601", [tank(), tank(0, { id: "tank-9" })], false, "tank-4"), /השתנה/);
});
test("missing batch number is rejected", () => {
  assert.match(reason("", [], false), /חסר/);
});

test("batch rename is removed end-to-end, while manual tank reassignment is untouched", () => {
  const view = read("../src/components/brewing/BrewingView.tsx");
  const client = read("../src/SERVICES/brewing/brewingSheetServer.ts");
  const post = read("../server/post.js");
  const service = read("../server/BREWING_SHEET_SERVICE.js");
  const reassignment = read("../src/components/tools/ManualBatchAssignment.tsx");
  assert.doesNotMatch(view, /ערוך מספר אצווה|saveProductionBatchEdit|editBatchDraft|serverRenameBrewSheet/);
  assert.doesNotMatch(client + post + service, /BrewSheetRenameBatch|brewingSheetRenameBatch_|serverRenameBrewSheet/);
  assert.match(reassignment, /assignAndRefreshTank/);
  assert.match(view, /await assertBatchCanBeDeleted\(run\.batchNumber\)/);
  assert.match(view, /await assertBatchCanBeDeleted\(run\.batchNumber, tank\.id\)/);
  assert.equal((view.match(/const cleanup = writeBatch\(db\)/g) || []).length, 2);
  assert.equal((view.match(/await cleanup\.commit\(\)/g) || []).length, 2);
  assert.match(view, /serverTrashBrewSheet\(run\.sheetId\)/);
  assert.match(view, /\+ יצירת בישול חדש/);
});
