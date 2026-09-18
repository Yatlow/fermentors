import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

function loadAppsScript(path, extra = {}) {
  const source = readFileSync(path, "utf8");
  const context = {
    console,
    Date,
    Number,
    String,
    Object,
    Array,
    JSON,
    Math,
    Map,
    Set,
    encodeURIComponent,
    decodeURIComponent,
    Logger: { log() {} },
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: path });
  return context;
}

const action = loadAppsScript("server/BREW_ACTION_SERVICE.js", {
  FIREBASE_PROJECT_ID: "test-project",
  BREW_FOLDER_ID: "test-folder",
  ScriptApp: { getOAuthToken: () => "token" },
  Utilities: { sleep() {}, formatDate: () => "2026-09-18" },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
  Drive: { Changes: {} },
  DriveApp: {},
  MimeType: { GOOGLE_SHEETS: "sheet" },
});

{
  let uploaded = 0;
  let transitioned = 0;
  action.findNextBrewForTankRecursive = () => null;
  action.uploadBrewToFirebase = () => { uploaded++; };
  action.updateFermentorForNextBrew_ = () => { transitioned++; };
  action.processAction5({ tankNumber: "10", batchNumber: "1593" }, [], {});
  assert.equal(uploaded, 0, "ACTION 5 must not upload when no future brew exists");
  assert.equal(transitioned, 0, "ACTION 5 must leave the tank unchanged when no future brew exists");
}

{
  let uploadOptions = null;
  let transitionArgs = null;
  action.findNextBrewForTankRecursive = () => ({ sheetUrl: "sheet-new", batchNumber: "1594" });
  action.uploadBrewToFirebase = (_url, options) => {
    uploadOptions = options;
    return { batchNumber: "1594", tankNumber: "10", beerStyle: "IPA" };
  };
  action.updateFermentorForNextBrew_ = (...args) => { transitionArgs = args; };
  action.processAction5({ tankNumber: "10", batchNumber: "1593" }, [], {});
  assert.deepEqual(JSON.parse(JSON.stringify(uploadOptions)), { skipFermentorUpdate: true });
  assert.ok(transitionArgs, "ACTION 5 must perform the consolidated tank transition");
  assert.equal(transitionArgs[0], "10");
  assert.equal(transitionArgs[2], "sheet-new");
  assert.equal(transitionArgs[3], 1593);
}

{
  const candidates = [
    { batch: 1594, fileId: "wrong", fileName: "1594 #" },
    { batch: 1595, fileId: "right", fileName: "1595 #" },
  ];
  action.extractBrewCached = (id) => id === "wrong"
    ? { tankNumber: "11", beerStyle: "IPA" }
    : { tankNumber: "10", beerStyle: "פייל", brewDate: "18/09/2026" };
  action.buildSheetUrl = (id) => "url:" + id;
  const found = action.findNextBrewForTankRecursive("10", 1593, candidates, {});
  assert.equal(found.batchNumber, "1595", "ACTION 5 must skip a future brew assigned to another tank");
  assert.equal(found.sheetUrl, "url:right");
}

const cycle = loadAppsScript("server/fermentor-cycle-optimization.js", {
  FIREBASE_PROJECT_ID: "test-project",
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {}, getProperties: () => ({}) }) },
  Utilities: { getUuid: () => "lease", formatDate: () => "2026-09-18" },
});

{
  const payload = cycle.fcFermentorPayload_({
    tankNumber: 10,
    currentData: { temp: 4, pressure: 1.2, kegs: null, crates: 0, totalLiters: undefined },
  });
  assert.equal(payload.currentData.temp, 4);
  assert.equal(payload.currentData.pressure, 1.2);
  assert.equal("kegs" in payload.currentData, false, "null packaging fields must not erase existing packaging data");
  assert.equal(payload.currentData.crates, 0, "explicit zero packaging values must be preserved");
  assert.equal("totalLiters" in payload.currentData, false);
}

{
  const outbox = loadAppsScript("server/sheetSyncOutbox.js", {
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_AUTH_PROJECT_ID: "test-project",
    ScriptApp: { getOAuthToken: () => "token" },
    UrlFetchApp: { fetch() { throw new Error("unexpected network"); } },
    postIdempotencyKey_: (_action, id) => id,
    postReadIdempotencyRecord_: () => null,
    runPostActionIdempotently_: () => ({ success: true, results: [{ success: true }] }),
    POST_IDEMPOTENCY_IN_PROGRESS_TTL_MS: 60_000,
  });
  assert.equal(outbox.sheetSyncNormalizeBatch_("#1593"), "1593");
  assert.equal(outbox.sheetSyncResponseSucceeded_({ success: true, results: [{ success: true }] }), true);
  assert.equal(outbox.sheetSyncResponseSucceeded_({ success: true, results: [{ success: false }] }), false);
  assert.equal(outbox.sheetSyncResponseSucceeded_({ success: false }), false);
}

console.log("Critical server regression tests passed");
