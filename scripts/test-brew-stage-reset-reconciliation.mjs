import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../server/BREW_ACTION_SERVICE.js");
let reconciliations = 0;
let extractedVolumes = 0;
let staleGuardChecks = 0;
const ctx = {
  Logger: { log() {} },
  extractBrewStageInfo: () => ({
    lastBlock: null, currentStage: null, blockCount: 0, headerCount: 1,
    blockStarts: [],
  }),
  updateFermentorBrewProgress: (_tank, stage, beforeWrite) => {
    assert.equal(stage.currentStage, null);
    assert.equal(beforeWrite(), true);
    reconciliations++;
  },
  extractBrew: () => { extractedVolumes++; return {}; },
};
vm.createContext(ctx);
vm.runInContext(source, ctx);
// The service defines its own network guard. Stub it after loading so
// these tests never call a real Firestore endpoint.
ctx.brewActionTankStillCurrent_ = () => { staleGuardChecks++; return true; };
const basic = { tankNumber: 2, batchNumber: "1601", sheetUrl: "https://docs.google.com/spreadsheets/d/test", action: 0 };

// The hot-path regression: 10 unstarted ACTION-0 passes must not even
// attempt to read/modify the Firestore brewProgress field.
for (let i = 0; i < 10; i++) {
  ctx.processAction0({ ...basic, brewProgress: { stageName: null, blockStarts: [], headerCount: 3 } });
}
assert.equal(reconciliations, 0, "unstarted brew must never issue an empty progress update");
assert.equal(staleGuardChecks, 0, "unstarted brew must never issue a Firestore stale-state GET");
assert.equal(extractedVolumes, 0, "unstarted brew must never be promoted to ACTION 1");

// Genuine rollback: a stored stage removed from Sheets must still be cleared.
ctx.processAction0({ ...basic, brewProgress: { stageCode: 20, stageName: "השריה", blockIndex: 1 } });
assert.equal(reconciliations, 1, "deleting a previously published stage must reconcile to empty");
assert.equal(staleGuardChecks, 1, "genuine rollback preserves the stale-state guard");
assert.equal(extractedVolumes, 0, "rollback must not promote ACTION 0");

// Even if the stage label was cleared in a previous edit, old recorded
// block timestamps require a final cleanup to avoid resurrecting the stage.
ctx.processAction0({ ...basic, brewProgress: { stageName: null, blockStarts: [{ blockIndex: 1, startedAt: "2026-11-01" }] } });
assert.equal(reconciliations, 2, "orphan block-start timestamps should be cleaned");

// After reset is stored, future cycles return to the no-work path.
ctx.processAction0({ ...basic, brewProgress: { stageName: null, blockStarts: [] } });
assert.equal(reconciliations, 2);

const extractor = read("../server/extractBrewStageInfo.js");
const savedStart = new Date("2026-11-01T08:30:00Z");
let reads = 0;
let reopens = 0;
const sheetValues = [["כותרת", "ללא זמנים"]];
const sheet = {
  getDataRange: () => ({ getDisplayValues: () => { reads++; return sheetValues; } }),
};
const standAlone = {
  Logger: { log() {} },
  FC_CYCLE_CONTEXT_: null,
  extractSpreadsheetId: (id) => id,
  SpreadsheetApp: { openById: () => { reopens++; return { getSheets: () => [sheet] }; } },
};
vm.createContext(standAlone);
vm.runInContext(extractor, standAlone);
const makeBlocks = (started) => [
  { rawStages: started ? [{ startMinutes: 510 }] : [] },
  { rawStages: [] },
];
const retained = standAlone.brewStageRegisterBlockStarts_(
  makeBlocks(true), [new Date("2026-11-01")], ["sheet"],
  { 1: savedStart, 2: savedStart },
);
assert.equal(Object.keys(retained).length, 1);
assert.ok(retained[1], "active block start remains");
assert.ok(!retained[2], "deleted block start is not resurrected");
const removed = standAlone.brewStageRegisterBlockStarts_(
  makeBlocks(false), [new Date("2026-11-01")], ["sheet"],
  { 1: savedStart },
);
assert.equal(Object.keys(removed).length, 0, "deleting all stage times clears old block timestamps");

// Outside the optimized cycle, the parser still reads the sheet normally.
standAlone.extractBrewStageInfo("test", {});
assert.equal(reopens, 1);
assert.equal(reads, 1);

// During the cycle, reuse the sheet snapshot instead of opening a second time.
// That makes ACTION 0 a single-sheet-read operation even with active stages.
let snapshotCalls = 0;
standAlone.FC_CYCLE_CONTEXT_ = { sheets: new Map() };
standAlone.fcSheetSnapshot_ = () => {
  snapshotCalls++;
  return { ss: {}, sheet, values: sheetValues };
};
standAlone.extractBrewStageInfo("test", {});
assert.equal(snapshotCalls, 1, "stage parser must request the shared cycle snapshot");
assert.equal(reopens, 1, "cycle parsing must not reopen the spreadsheet");
assert.equal(reads, 1, "cycle parsing must not re-read the whole sheet");

console.log("ACTION-0 empty-stage no-op, real rollback, and one-read stage sync passed");
