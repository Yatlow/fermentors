import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/BREW_ACTION_SERVICE.js", import.meta.url), "utf8");
let reconciliations = 0;
let extractedVolumes = 0;
const ctx = {
  Logger: { log() {} },
  extractBrewStageInfo: () => ({ lastBlock: null, currentStage: null, blockCount: 0, headerCount: 1 }),
  updateFermentorBrewProgress: (_tank, stage, beforeWrite) => {
    assert.equal(stage.currentStage, null);
    assert.equal(beforeWrite(), true);
    reconciliations++;
  },
  brewActionTankStillCurrent_: () => true,
  extractBrew: () => { extractedVolumes++; return {}; },
};
vm.createContext(ctx);
vm.runInContext(source, ctx);
ctx.processAction0({ tankNumber: 2, sheetUrl: "https://docs.google.com/spreadsheets/d/test", action: 0 });
assert.equal(reconciliations, 1, "empty brew stages must clear stale live progress");
assert.equal(extractedVolumes, 0, "an empty timeline must not accidentally transition ACTION 0");
console.log("Empty-stage reconciliation checks passed");
