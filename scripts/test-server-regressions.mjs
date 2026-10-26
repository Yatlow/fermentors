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

// A maintenance cycle may briefly own the global ScriptLock. Reporting must
// wait for it instead of treating a 1.5s busy lock as a Sheet sync failure.
{
  const properties = new Map();
  const locked = [];
  const post = loadAppsScript("server/post.js", {
    LockService: {
      getScriptLock: () => ({
        waitLock(milliseconds) { locked.push(milliseconds); },
        releaseLock() { locked.push("released"); },
      }),
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (name) => properties.get(name) ?? null,
      setProperty: (name, value) => properties.set(name, value),
      deleteProperty: (name) => properties.delete(name),
    }) },
  });
  const claim = post.postClaimIdempotencyRequest_("addFermentationMeasurements", "lock-test");
  assert.equal(claim.state, "claimed");
  assert.deepEqual(locked, [20000, "released"], "outbox reports must tolerate maintenance lock contention");
}

const measurementIdentity = loadAppsScript("server/batchDataExtractionService.js");
{
  const date = new Date(2026, 9, 6);
  const id = (time) => measurementIdentity.createMeasurementId(date, time);
  assert.equal(id("6:27"), "2026-10-06_0627");
  assert.equal(id("06:27"), "2026-10-06_0627");
  assert.equal(id("627"), "2026-10-06_0627");
  assert.equal(id("0627"), "2026-10-06_0627");
  assert.equal(id("9:05"), "2026-10-06_0905");
  assert.equal(id("10:05"), "2026-10-06_1005");
  assert.equal(id("23:59"), "2026-10-06_2359");
  assert.equal(measurementIdentity.createDailyMeasurementId(date), "2026-10-06", "canonical measurement ID is date only");
  assert.equal(measurementIdentity.createDailyMeasurementId(new Date(2026, 0, 2)), "2026-01-02");

  assert.equal(id(""), "2026-10-06_0000");
}

const styleAverages = loadAppsScript("server/calculateWeeklyStyleAverages.js");
{
  const duplicates = styleAverages.dedupeStyleMeasurements_([
    { __measurementDocId: "2026-10-06_627", __measurementCreatedAt: "2026-10-06T06:27:00Z", date: "06/10/2026", plato: 8, pressure: 1.1, notes: "הורדת שמרים" },
    { __measurementDocId: "2026-10-06_0627", __measurementCreatedAt: "2026-10-06T06:28:00Z", date: "06/10/2026", plato: 7.5, temp: 12, notes: "שינוי לחץ" },
    { __measurementDocId: "2026-10-07_0715", __measurementCreatedAt: "2026-10-07T07:15:00Z", date: "07/10/2026", plato: 6 },
  ], "1600");
  assert.equal(duplicates.length, 2, "one logical measurement per brew/day");
  assert.equal(duplicates[0].plato, 7.5, "newest creation timestamp wins conflicting values");
  assert.equal(duplicates[0].pressure, 1.1);
  assert.equal(duplicates[0].temp, 12, "latest nonempty value is retained");
  assert.equal(duplicates[0].notes, "הורדת שמרים | שינוי לחץ", "keep both distinct notes");

  const differentTimes = styleAverages.dedupeStyleMeasurements_([
    { __measurementDocId: "2026-10-06_0930", __measurementCreatedAt: "2026-10-06T09:30:00Z", date: "06/10/2026", plato: 7 },
    { __measurementDocId: "2026-10-06_0800", __measurementCreatedAt: "2026-10-06T08:00:00Z", date: "06/10/2026", plato: 8 },
  ], "1600");
  assert.equal(differentTimes.length, 1, "different times on one day must merge");
  assert.equal(differentTimes[0].plato, 7, "newest measurement wins irrespective of input order");

}

const historyReconcile = loadAppsScript("server/sync Active Historical Measurements.js");
{
  assert.equal(historyReconcile.dedupeHistoricalMeasurementsForBatch_("test", "1600", []), 0,
    "legacy timestamp-based automatic deletes must remain disabled");
  assert.equal(historyReconcile.historicalMeasurementDayFromId_("2026-10-06"), "2026-10-06");
  assert.equal(historyReconcile.historicalMeasurementDayFromId_("2026-10-06_627"), "2026-10-06");
}

const outboxReconcile = loadAppsScript("server/sheetSyncOutbox.js", {
  FIREBASE_PROJECT_ID: "test-project",
});
{
  let submitted = null;
  outboxReconcile.sheetSyncField_ = (job, name) => job.fields[name];
  outboxReconcile.sheetSyncDocumentsUrl_ = () => "mock://firestore";
  outboxReconcile.sheetSyncProjectId_ = () => "test-project";
  outboxReconcile.sheetSyncGetFermentor_ = () => ({
    name: "projects/test-project/databases/(default)/documents/fermentors/4",
    updateTime: "2026-10-06T07:30:00Z",
    fields: { batchNumber: "1600" },
  });
  outboxReconcile.sheetSyncFetch_ = (_url, options) => {
    submitted = JSON.parse(options.payload);
    return { getResponseCode: () => 200 };
  };
  outboxReconcile.sheetSyncReconcileMeasurements_({
    fields: {
      action: "addFermentationMeasurements",
      readingsJson: JSON.stringify([{ tankId: "4", batchNumber: "1600" }]),
    },
  }, { results: [{
    tankId: "4", success: true,
    result: { date: "06/10/2026", time: "07:33", temperature: "12.3", notes: "test" },
  }] });
  assert.equal(submitted.writes.length, 2);
  assert.equal(submitted.writes[0].currentDocument.updateTime, "2026-10-06T07:30:00Z");
  assert.ok(submitted.writes[1].update.name.endsWith("/brews/1600/measurements/2026-10-06"),
    "outbox must upsert the same daily document, not a timestamped document");
}

const fermentationNotes = loadAppsScript("server/addFermentationMeasurement.js");
{
  assert.equal(
    fermentationNotes.appendFermentationNotesSafely_(
      "העלאת לחץ ל: 1.2 bar",
      "העלאת לחץ ל: 1.2 bar",
    ),
    "העלאת לחץ ל: 1.2 bar",
    "an immediate exact duplicate cellar action must not be appended twice",
  );
  assert.equal(
    fermentationNotes.appendFermentationNotesSafely_(
      "הורדת שמרים | העלאת לחץ ל: 1.2 bar",
      "העלאת לחץ ל: 1.2 bar",
    ),
    "הורדת שמרים | העלאת לחץ ל: 1.2 bar",
    "the same final action must be treated as a duplicate",
  );
  assert.equal(
    fermentationNotes.appendFermentationNotesSafely_(
      "העלאת לחץ ל: 1.2 bar | הורדת שמרים",
      "העלאת לחץ ל: 1.2 bar",
    ),
    "העלאת לחץ ל: 1.2 bar | הורדת שמרים | העלאת לחץ ל: 1.2 bar",
    "a repeated action separated by another operation must remain recordable",
  );
}

const action = loadAppsScript("server/BREW_ACTION_SERVICE.js", {
  FIREBASE_PROJECT_ID: "test-project",
  BREW_FOLDER_ID: "test-folder",
  ScriptApp: { getOAuthToken: () => "token" },
  Utilities: { sleep() {}, formatDate: () => "2026-09-18" },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
  Drive: { Changes: {} },
  DriveApp: { getFileById: () => ({ isTrashed: () => false }) },
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
  let cleanedBatch = "";
  action.getPendingBrewsForAction5_ = () => [{
    batchNumber: "1594",
    tankNumber: "10",
    sheetUrl: "sheet-new",
  }];
  action.uploadBrewToFirebase = () => ({
    batchNumber: "1594",
    tankNumber: "10",
    beerStyle: "IPA",
  });
  action.updateFermentorForNextBrew_ = () => true;
  action.deleteConsumedPendingBrew_ = (batch) => { cleanedBatch = String(batch); };
  action.processAction5(
    { tankNumber: "10", batchNumber: "1593", sheetUrl: "sheet-old" },
    { pendingBrews: null, candidates: null, brewExtractCache: {} },
  );
  assert.equal(cleanedBatch, "1594", "ACTION 5 must remove a consumed pending brew after a successful transition");

  cleanedBatch = "";
  action.updateFermentorForNextBrew_ = () => false;
  action.processAction5(
    { tankNumber: "10", batchNumber: "1593", sheetUrl: "sheet-old" },
    { pendingBrews: null, candidates: null, brewExtractCache: {} },
  );
  assert.equal(cleanedBatch, "", "ACTION 5 must keep pending brew records when the tank transition aborts");
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

{
  let guardCalls = 0;
  let patchCalls = 0;
  let progressHash = null;
  const progress = loadAppsScript("server/extractBrewStageInfo.js", {
    FIREBASE_PROJECT_ID: "test-project",
    FC_CYCLE_CONTEXT_: null,
    ScriptApp: { getOAuthToken: () => "token" },
    UrlFetchApp: {
      fetch() {
        patchCalls++;
        return { getResponseCode: () => 200, getContentText: () => "{}" };
      },
    },
    hasChangedLocally_: (_key, value) => {
      const next = JSON.stringify(value);
      if (progressHash === next) return false;
      progressHash = next;
      return true;
    },
  });
  const stageInfo = {
    currentBlockIndex: 1,
    blockCount: 2,
    headerCount: 1,
    currentStage: null,
    dateAssumed: false,
    blockStarts: [],
  };

  progress.updateFermentorBrewProgress("10", stageInfo, () => {
    guardCalls++;
    return true;
  });
  assert.equal(guardCalls, 1, "ACTION 0 stale guard must run before a real brewProgress write");
  assert.equal(patchCalls, 1, "changed brewProgress must still be written");

  progress.updateFermentorBrewProgress("10", stageInfo, () => {
    guardCalls++;
    return true;
  });
  assert.equal(guardCalls, 1, "unchanged brewProgress must skip the expensive ACTION 0 stale read");
  assert.equal(patchCalls, 1, "unchanged brewProgress must skip Firestore write");
}

{
  const source = readFileSync("server/BREW_ACTION_SERVICE.js", "utf8");
  const readFn = source.slice(
    source.indexOf("function getAllFermentorsFromFirebase()"),
    source.indexOf("function ", source.indexOf("function getAllFermentorsFromFirebase()") + 10),
  );
  assert.doesNotMatch(
    readFn,
    /actionWrites\+\+/,
    "the fermentor list GET must never be counted as an ACTION write",
  );
  const actionFn = source.slice(
    source.indexOf("function updateFermentorAction("),
    source.indexOf("function ", source.indexOf("function updateFermentorAction(") + 10),
  );
  assert.match(actionFn, /actionWrites\+\+/, "successful ACTION patches must be counted at updateFermentorAction");
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
  let eagerDriveScans = 0;
  let seenContext = null;
  const optimized = loadAppsScript("server/OptimisedSync.js", {
    Utilities: {
      computeDigest: () => [1],
      DigestAlgorithm: { MD5: "MD5" },
      Charset: { UTF_8: "UTF_8" },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => null,
        setProperty() {},
      }),
    },
    parseAction: (value) => Number(value),
    fcTimed_: (_label, callback) => callback(),
    getBrewFolderCandidatesCached: () => {
      eagerDriveScans += 1;
      return [];
    },
    processAction0() {},
    processAction1() {},
    processAction5: (_fermentor, context) => {
      seenContext = context;
    },
    brewingSheetReconcileEditTriggers_() {},
    ensureAsyncLogTrigger_() {},
  });
  optimized.runActionFlow_([{ id: "10", data: { tankNumber: "10", action: 5 } }]);
  assert.equal(eagerDriveScans, 0, "ACTION 5 must not scan Drive before Firestore pending brews are checked");
  assert.ok(seenContext, "ACTION 5 must receive a shared cycle context");
  assert.equal(seenContext.pendingBrews, null);
  assert.equal(seenContext.candidates, null);
  assert.deepEqual(JSON.parse(JSON.stringify(seenContext.brewExtractCache)), {});
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



{
  let patched = null;
  const manualStatus = loadAppsScript("server/assignAndRefreshTank.js", {
    FIREBASE_PROJECT_ID: "test-project",
    ScriptApp: { getOAuthToken: () => "token" },
    getFermentorFromFirestore: () => ({
      action: 1,
      batchNumber: "1593",
      tankStatus: false,
    }),
    UrlFetchApp: {
      fetch(_url, options) {
        patched = JSON.parse(options.payload);
        return {
          getResponseCode: () => 200,
          getContentText: () => "{}",
        };
      },
    },
    logToSheet() {},
  });

  const result = manualStatus.applyManualStatusChange("10", 3, true, "1593", 1);
  assert.equal(result.action, 3);
  assert.equal(result.tankStatus, true);
  assert.equal(patched.fields.action.integerValue, "3");
  assert.equal(patched.fields.tankStatus.booleanValue, true);

  manualStatus.getFermentorFromFirestore = () => ({
    action: 4,
    batchNumber: "1593",
    tankStatus: true,
  });
  assert.throws(
    () => manualStatus.applyManualStatusChange("10", 3, true, "1593", 1),
    /סטטוס המיכל השתנה/,
    "manual status commit must abort when the status changed after confirmation",
  );
}



{
  let lastPatchUrl = "";
  const brewOutbox = loadAppsScript("server/brewSheetCreationOutbox.js", {
    sheetSyncField_: (doc, name) => doc?.fields?.[name] ?? null,
    sheetSyncDocumentId_: (doc) => doc?.id || "1601",
    sheetSyncDocumentsUrl_: (suffix) => "https://example.invalid" + suffix,
    sheetSyncFetch_: (url) => {
      lastPatchUrl = url;
      return {
        getResponseCode: () => 412,
        getContentText: () => "",
      };
    },
  });

  const freshCreating = {
    fields: {
      state: "creating",
      updatedAt: new Date().toISOString(),
      fileId: "",
    },
  };
  const staleCreating = {
    fields: {
      state: "creating",
      updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      fileId: "",
    },
  };
  const queued = { fields: { state: "queued" } };

  assert.equal(
    brewOutbox.brewCreateIsRunnableDocument_(freshCreating),
    false,
    "a fresh creating brew job must not be claimed by a second worker",
  );
  assert.equal(
    brewOutbox.brewCreateIsRunnableDocument_(staleCreating),
    true,
    "a stale creating brew job must be recoverable by maintenance",
  );
  assert.equal(
    brewOutbox.brewCreateIsRunnableDocument_(queued),
    true,
    "queued brew jobs must remain runnable",
  );

  const claimed = brewOutbox.brewCreatePatchJob_(
    "1601",
    { state: "creating" },
    "2026-09-25T18:00:00.000000Z",
  );
  assert.equal(claimed, false, "Firestore precondition conflicts must lose the job claim cleanly");
  assert.match(
    lastPatchUrl,
    /currentDocument\.updateTime=/,
    "brew job claims must use a Firestore updateTime precondition",
  );

  brewOutbox.sheetSyncFetch_ = (url) => {
    lastPatchUrl = url;
    return {
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }),
    };
  };
  assert.equal(
    brewOutbox.brewCreatePatchJob_(
      "1601",
      { state: "creating" },
      "2026-09-25T18:00:00.000000Z",
    ),
    false,
    "Firestore HTTP 400 FAILED_PRECONDITION must also lose the job claim cleanly",
  );
}




{
  // Reproduction: wheat has a third rest, so block B's out-to-boil pH and
  // the rinse+grant cells have shifted relative to the legacy template.
  const rows = Array.from({ length: 136 }, () => Array(8).fill(""));
  const put = (row, column, value) => { rows[row - 1]["ABCDEFGH".indexOf(column)] = value; };
  for (const header of [4, 58]) {
    put(header, "B", "סוג:");
    put(header, "D", "אצווה:");
  }
  for (const [row, label] of [
    [9, "הכנסת לתת"], [21, "השריה 3"], [23, "חימום 3"],
    [28, "הוצאה לבישול"], [33, "שטיפה 5"],
    [63, "הכנסת לתת"], [75, "השריה 3"], [77, "חימום 3"],
    [90, "הוצאה לבישול"], [101, "שטיפה 5"],
  ]) put(row, "D", label);
  put(28, "H", "pH 5.45");
  put(90, "H", "pH 5.45");
  put(33, "H", "1250+50");
  put(101, "H", "1250+50");
  put(7, "A", "HLT"); put(8, "A", "MASH IN");
  put(61, "A", "HLT"); put(62, "A", "MASH IN");
  put(115, "A", "יום בישול"); put(115, "E", "שעת הוספת שמרים");
  let publishUrl = "";
  let publishPayload = null;
  const brewCreate = loadAppsScript("server/brewSheetCreationOutbox.js", {
    SpreadsheetApp: { openById: () => ({ getSheets: () => [{
      getDataRange: () => ({ getDisplayValues: () => rows }),
    }] }) },
    sheetSyncDocumentsUrl_: (path) => "https://firestore.test" + path,
    sheetSyncFetch_: (url, options) => {
      publishUrl = url;
      publishPayload = JSON.parse(options.payload);
      return { getResponseCode: () => 200 };
    },
  });
  const rowMap = brewCreate.brewCreateSheetRowMap_("mock-sheet", "double");
  assert.equal(rowMap["1"]["__sheetRow.stage.outToBoil"], "28");
  assert.equal(rowMap["2"]["__sheetRow.stage.outToBoil"], "90");
  assert.equal(rowMap["2"]["__sheetRow.rinse.5"], "101");
  assert.equal(rowMap["2"]["__sheetRow.stage.rest3"], "75");
  assert.equal(rowMap["2"]["__sheetRow.water.mashIn"], "62");
  assert.equal(rowMap["2"]["__sheetRow.fermentation"], "115");
  brewCreate.brewCreatePublishRowMap_({ batchNumber: "1605", tankType: "double" }, "mock-sheet");
  assert.match(publishUrl, /updateMask.fieldPaths=brewSheetRowMapJson/);
  assert.deepEqual(Object.keys(publishPayload.fields), ["brewSheetRowMapJson"],
    "creation must publish row metadata only, not overwrite brew input data");
  const saved = JSON.parse(publishPayload.fields.brewSheetRowMapJson.stringValue);
  assert.equal(saved.blocks["2"]["__sheetRow.stage.outToBoil"], "90");
}

console.log("Critical server regression tests passed");


/* Regression: triple brew grain lot at B59/B106 was remapped into the brew
   date B156 by treating every Master fallback row as a fermentation row. */
{
  const cellsFor = (blocks, fermentationRow) => {
    const cells = Array.from({ length: Math.max(190, fermentationRow + 1) }, () => []);
    for (const headerRow of [4, 54, 102].slice(0, blocks)) {
      cells[headerRow - 1][1] = "סוג:";
      cells[headerRow - 1][3] = "אצווה:";
    }
    cells[fermentationRow - 1][0] = "יום בישול ";
    cells[fermentationRow - 1][2] = "סוכר תחילי";
    cells[fermentationRow - 1][4] = "שעת הוספת שמרים";
    return cells;
  };
  const mockSheet = (cells) => {
    const writes = [];
    const address = (row, col) => ({
      getRow: () => row, getColumn: () => col,
      getNumRows: () => 1, getNumColumns: () => 1,
      getA1Notation: () => `${String.fromCharCode(64 + col)}${row}`,
      getDisplayValue: () => String(cells[row - 1]?.[col - 1] || ""),
      setValue(value) { cells[row - 1][col - 1] = value; writes.push({ row, col, value }); },
    });
    return {
      writes,
      getDataRange: () => ({ getDisplayValues: () => cells }),
      getRange(row, col) {
        if (typeof row === "string") {
          const match = /([A-Z]+)(\d+)/.exec(row);
          if (!match) throw Error("invalid range");
          return address(Number(match[2]), match[1].charCodeAt(0) - 64);
        }
        return address(row, col);
      },
      getLastRow: () => cells.length,
    };
  };

  const service = loadAppsScript("server/BREWING_SHEET_SERVICE.js");
  for (const [blocks, fermentationRow] of [
    [1, 63], [2, 114], [3, 168],
  ]) {
    const sheet = mockSheet(cellsFor(blocks, fermentationRow));
    // Legacy A1 addresses never silently remap; only explicit semantic intent
    // can change a destination. In particular grain lot B59 is never moved.
    for (const oldRow of [59, 60, 106, 156]) {
      assert.equal(
        service.brewingSheetResolveFermentationMetadataRange_(
          sheet, sheet.getRange(oldRow, 2),
        ).getRow(),
        oldRow,
        `layout ${blocks}: untagged B${oldRow} must stay put`,
      );
    }
    assert.equal(
      service.brewingSheetResolveFermentationMetadataRange_(
        sheet, sheet.getRange(59, 2), "fermentation.brewDate",
      ).getRow(),
      fermentationRow,
      `layout ${blocks}: tagged brewDate resolves by semantic label`,
    );
  }

  const triple = mockSheet(cellsFor(3, 156));
  const writingService = loadAppsScript("server/BREWING_SHEET_SERVICE.js", {
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: () => triple, getSheets: () => [triple] }),
      flush: () => {},
    },
  });
  writingService.brewingSheetWriteCells_({
    spreadsheetId: "mock-triple", writes: [
      { range: "'גיליון1'!B59", value: "Pilsner #217205" },
      { range: "'גיליון1'!B156", value: "19/10/2026" },
    ],
  });
  assert.equal(triple.writes[0].row, 59, "grain lot must stay in second brew, not replace the date");
  assert.equal(triple.writes[1].row, 156);
  assert.equal(triple.getRange(156, 2).getDisplayValue(), "19/10/2026");
  assert.throws(
    () => writingService.brewingSheetWriteCells_({
      spreadsheetId: "mock-triple",
      writes: [{ range: "'גיליון1'!B156", value: "Pilsner #217205" }],
    }),
    /Refusing non-date write/,
    "defense in depth: a grain label must never overwrite the brew date",
  );
}
