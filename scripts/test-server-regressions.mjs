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
  parseBatchNumber: (value) => { const n = Number(String(value ?? "").replace("#", "").trim()); return Number.isFinite(n) ? n : null; },
  extractBrew: (id) => ({
    wrong: { tankNumber: "11", beerStyle: "IPA" },
    right: { tankNumber: "10", beerStyle: "פייל", brewDate: "18/09/2026" },
  })[id],
  buildSheetUrl: (id) => "url:" + id,
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
  // Earlier processAction5 tests intentionally replace globals. Reload the
  // Apps Script file so this search test exercises its real lexical functions.
  const searchAction = loadAppsScript("server/BREW_ACTION_SERVICE.js", {
    FIREBASE_PROJECT_ID: "test-project",
    BREW_FOLDER_ID: "test-folder",
    ScriptApp: { getOAuthToken: () => "token" },
    Utilities: { sleep() {}, formatDate: () => "2026-09-18" },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
    Drive: { Changes: {} },
    DriveApp: {},
    MimeType: { GOOGLE_SHEETS: "sheet" },
    parseBatchNumber: (value) => { const n = Number(String(value ?? "").replace("#", "").trim()); return Number.isFinite(n) ? n : null; },
    extractBrew: (id) => ({
      wrong: { tankNumber: "11", beerStyle: "IPA" },
      right: { tankNumber: "10", beerStyle: "פייל", brewDate: "18/09/2026" },
    })[id],
    buildSheetUrl: (id) => "url:" + id,
  });
  const candidates = [
    { batch: 1594, fileId: "wrong", fileName: "1594 #" },
    { batch: 1595, fileId: "right", fileName: "1595 #" },
  ];
  const found = searchAction.findNextBrewForTankRecursive("10", 1593, candidates, {});
  assert.equal(found.batchNumber, "1595", "ACTION 5 must skip a future brew assigned to another tank");
  assert.equal(found.sheetUrl, "https://docs.google.com/spreadsheets/d/right/edit");
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

{
  let lastFullCycleAt = null;
  const maintenance = loadAppsScript("server/asyncLogTrigger.js", {
    FIREBASE_PROJECT_ID: "test-project",
    normalizeFirestoreValue: (value) => value,
    Utilities: {
      formatDate(date, _tz, pattern) {
        const hh = String(date.getUTCHours()).padStart(2, "0");
        const mm = String(date.getUTCMinutes()).padStart(2, "0");
        if (pattern === "HH:mm") return hh + ":" + mm;
        if (pattern === "yyyyMMdd") return "20260918";
        return "";
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => lastFullCycleAt,
        setProperty: (_key, value) => { lastFullCycleAt = value; },
        deleteProperty() {},
      }),
    },
    ScriptApp: { getOAuthToken: () => "token", getProjectTriggers: () => [] },
    UrlFetchApp: { fetch() { throw new Error("unexpected network"); } },
    processAction0() {},
  });
  const at = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 18, hour, minute));
  assert.equal(maintenance.smartIsDaySyncWindow_(at(4, 29)), false);
  assert.equal(maintenance.smartIsDaySyncWindow_(at(4, 30)), true);
  assert.equal(maintenance.smartIsDaySyncWindow_(at(16, 59)), true);
  assert.equal(maintenance.smartIsDaySyncWindow_(at(17, 0)), false);
  assert.equal(maintenance.smartDateKey_("18/09/2026"), 20260918);
  assert.equal(maintenance.smartDateKey_("2026-09-18"), 20260918);
  assert.equal(maintenance.smartAction0IsDue_({ data: { brewDate: "18/09/2026" } }, at(2)), true);
  assert.equal(maintenance.smartAction0IsDue_({ data: { brewDate: "19/09/2026" } }, at(2)), false);
  assert.equal(maintenance.smartAction0IsDue_({ data: { brewDate: "" } }, at(2)), true);

  lastFullCycleAt = String(at(18).getTime());
  assert.equal(maintenance.smartShouldRunFullCycle_(at(18, 30)), false, "night full sync must stay throttled inside one hour");
  assert.equal(maintenance.smartShouldRunFullCycle_(at(19, 0)), true, "night full sync must run after one hour");
  assert.equal(maintenance.smartShouldRunFullCycle_(at(10, 0)), true, "day window must always run the full cycle");
}

console.log("Critical server regression tests passed");
