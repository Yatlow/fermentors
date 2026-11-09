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

// The actual 1616A Sheet layout: stage 70 at 08:08, followed by rinses
// recorded in the same semantic D/E columns. The 5-minute ACTION-0 parser
// must select the last rinse without an extra Sheet fetch or Firestore read.
const rows = Array.from({ length: 62 }, () => Array(8).fill(""));
rows[0][6] = "תאריך:"; rows[0][7] = "08/11/2026";
rows[3][1] = "סוג:"; rows[3][3] = "אצווה:";
rows[3][6] = "תאריך"; rows[3][7] = "08/11/2026";
rows[7][3] = "פעולה"; rows[7][4] = "ש. התחלה"; rows[7][5] = "ש. סיום";
rows[23][3] = "הוצאה לבישול"; rows[23][4] = "8:08";
for (const [i, time] of ["8:42", "9:13", "9:40", "10:13", "10:32"].entries()) {
  rows[26 + i][3] = `שטיפה ${i + 1}`;
  rows[26 + i][4] = time;
}
rows[53][1] = "סוג:"; rows[53][3] = "אצווה:"; rows[53][6] = "תאריך";
rows[57][3] = "פעולה"; rows[57][4] = "ש. התחלה"; rows[57][5] = "ש. סיום";
rows[60][0] = "דף תסיסה";
sheetValues.splice(0, sheetValues.length, ...rows);
standAlone.FC_CYCLE_CONTEXT_ = null;
const parsed = standAlone.extractBrewStageInfo("test", { tankNumber: 6, brewDate: "08/11/2026" });
assert.equal(parsed.currentStage?.code, 80);
assert.equal(parsed.currentStage?.name, "שטיפה 5");
assert.equal(standAlone.brewStageFormatHHMM_(parsed.currentStage?.startDateTime), "10:32");

console.log("ACTION-0 empty-stage no-op, real rollback, and one-read stage sync passed");
