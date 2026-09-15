// ============================================================
// GLOBAL LOGGING (buffered — נכתב פעם אחת בסוף כל בקשה)
// ============================================================

const LOG_SHEET_ID = "1Uoenz65Dx0inv3r6ZR4hCiF4JMx0U0BHG7W5tsfG8mc";

let _logBuffer = [];

function logToSheet(message) {
  _logBuffer.push([new Date(), String(message)]);
}

function flushLogs_() {
  if (_logBuffer.length === 0) return;
  try {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheetByName("Logs") || ss.insertSheet("Logs");
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, _logBuffer.length, 2).setValues(_logBuffer);
  } catch (err) {
    console.log("flushLogs_ FAILED: " + err.message);
  } finally {
    _logBuffer = [];
  }
}

// ============================================================
// GENERIC POST IDEMPOTENCY
// ============================================================

const POST_IDEMPOTENCY_PREFIX = "post_idempotency:";
const POST_IDEMPOTENCY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const POST_IDEMPOTENCY_IN_PROGRESS_TTL_MS = 2 * 60 * 1000;
const POST_IDEMPOTENCY_WAIT_MS = 20000;
const POST_IDEMPOTENCY_POLL_MS = 250;

const POST_MUTATION_ACTIONS = {
  logPackagingToMasterSheet: true,
  addFermentationMeasurements: true,
  AssignAndRefreshTank: true,
  updateTankStatus: true,
  assignDryHop: true,
  updatePackagingInfo: true,
  AssignBatch: true,
  refreshSingleTank: true,
  addFermentationMeasurement: true,
  triggerTankUpdate: true
};

function postIdempotencyKey_(action, requestId) {
  return POST_IDEMPOTENCY_PREFIX + String(action || "unknown") + ":" + String(requestId || "");
}

function postReadIdempotencyRecord_(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed.savedAt || parsed.startedAt || 0);

    if (!savedAt || Date.now() - savedAt > POST_IDEMPOTENCY_TTL_MS) {
      PropertiesService.getScriptProperties().deleteProperty(key);
      return null;
    }

    return parsed;
  } catch (error) {
    PropertiesService.getScriptProperties().deleteProperty(key);
    return null;
  }
}

function postClaimIdempotencyRequest_(action, requestId) {
  const key = postIdempotencyKey_(action, requestId);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const existing = postReadIdempotencyRecord_(key);

    if (existing && existing.state === "done" && existing.response) {
      return { key: key, state: "done", response: existing.response };
    }

    if (
      existing &&
      existing.state === "in_progress" &&
      Date.now() - Number(existing.startedAt || 0) <= POST_IDEMPOTENCY_IN_PROGRESS_TTL_MS
    ) {
      return { key: key, state: "in_progress" };
    }

    PropertiesService.getScriptProperties().setProperty(
      key,
      JSON.stringify({
        state: "in_progress",
        action: String(action || ""),
        requestId: String(requestId || ""),
        startedAt: Date.now()
      })
    );

    return { key: key, state: "claimed" };
  } finally {
    lock.releaseLock();
  }
}

function postWaitForIdempotencyResult_(key) {
  const deadline = Date.now() + POST_IDEMPOTENCY_WAIT_MS;

  while (Date.now() < deadline) {
    Utilities.sleep(POST_IDEMPOTENCY_POLL_MS);
    const existing = postReadIdempotencyRecord_(key);

    if (existing && existing.state === "done" && existing.response) {
      return existing.response;
    }

    if (!existing || existing.state !== "in_progress") {
      return null;
    }
  }

  return null;
}

function postSaveIdempotencyResult_(key, action, requestId, response) {
  PropertiesService.getScriptProperties().setProperty(
    key,
    JSON.stringify({
      state: "done",
      action: String(action || ""),
      requestId: String(requestId || ""),
      savedAt: Date.now(),
      response: response
    })
  );
}

function postReleaseFailedIdempotencyClaim_(key) {
  try {
    const existing = postReadIdempotencyRecord_(key);
    if (existing && existing.state === "in_progress") {
      PropertiesService.getScriptProperties().deleteProperty(key);
    }
  } catch (error) {
    console.log("Failed releasing idempotency claim: " + error.message);
  }
}

function postCleanupIdempotencyCache_() {
  if (Math.random() > 0.02) return;

  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(POST_IDEMPOTENCY_PREFIX) !== 0) return;

    try {
      const parsed = JSON.parse(all[key]);
      const savedAt = Number(parsed.savedAt || parsed.startedAt || 0);
      if (!savedAt || now - savedAt > POST_IDEMPOTENCY_TTL_MS) {
        props.deleteProperty(key);
      }
    } catch (error) {
      props.deleteProperty(key);
    }
  });
}

function runPostActionIdempotently_(data) {
  const action = String(data.action || "");
  const requestId = String(data.requestId || "").trim();

  if (!POST_MUTATION_ACTIONS[action] || !requestId) {
    return executePostAction_(data);
  }

  const claim = postClaimIdempotencyRequest_(action, requestId);

  if (claim.state === "done") {
    logToSheet("IDEMPOTENCY HIT: " + action + " requestId=" + requestId);
    return Object.assign({}, claim.response, {
      duplicate: true,
      requestId: requestId
    });
  }

  if (claim.state === "in_progress") {
    logToSheet("IDEMPOTENCY WAIT: " + action + " requestId=" + requestId);
    const waitedResponse = postWaitForIdempotencyResult_(claim.key);

    if (waitedResponse) {
      return Object.assign({}, waitedResponse, {
        duplicate: true,
        requestId: requestId
      });
    }

    throw new Error("Request is already being processed. Please retry shortly.");
  }

  try {
    const response = executePostAction_(data);
    const persistedResponse = Object.assign({}, response, {
      requestId: requestId
    });

    postSaveIdempotencyResult_(claim.key, action, requestId, persistedResponse);
    postCleanupIdempotencyCache_();
    return persistedResponse;
  } catch (error) {
    postReleaseFailedIdempotencyClaim_(claim.key);
    throw error;
  }
}


function doGet(e) {
  try {
    logToSheet("GET event: " + JSON.stringify(e));

    if (!e || !e.parameter) {
      throw new Error("No GET parameters received");
    }

    const action = e.parameter.action;

    if (action === "CheckBatchAssignment") {
      const tankID = String(e.parameter.tankID || "").trim();
      const requestedBatch = Number(e.parameter.requestedBatch);
      if (!tankID) throw new Error("Missing tankID");
      if (!Number.isFinite(requestedBatch)) throw new Error("Invalid requestedBatch");
      return jsonResponse({ success: true, result: checkBatchForTank(tankID, requestedBatch) });
    }

    if (action === "FindNextBatchForTank") {
      const tankID = String(e.parameter.tankID || "").trim();
      const currentBatch = Number(e.parameter.currentBatch);
      if (!tankID) throw new Error("Missing tankID");
      if (!Number.isFinite(currentBatch)) throw new Error("Invalid currentBatch");
      return jsonResponse({ success: true, result: findNextBrewForTankRecursive(tankID, currentBatch) });
    }

    if (action === "CheckStatusTransition") {
      const tankID = String(e.parameter.tankID || "").trim();
      const toAction = Number(e.parameter.toAction);
      if (!tankID) throw new Error("Missing tankID");
      return jsonResponse({ success: true, result: checkStatusTransition(tankID, toAction) });
    }

    throw new Error("Unknown action: " + action);
  } catch (error) {
    logToSheet("doGet ERROR: " + error.stack);
    return jsonResponse({ success: false, error: error.message });
  } finally {
    flushLogs_();
  }
}


function doPost(e) {
  const startTime = Date.now();

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No POST data received");
    }

    const data = JSON.parse(e.postData.contents);
    logToSheet("Action requested: " + data.action + " requestId=" + String(data.requestId || "none"));

    const response = runPostActionIdempotently_(data);
    return jsonResponse(response);
  } catch (error) {
    logToSheet("doPost ERROR: " + error.stack);
    return jsonResponse({ success: false, error: error.message });
  } finally {
    logToSheet("Total doPost time: " + (Date.now() - startTime) + "ms");
    flushLogs_();
  }
}


function executePostAction_(data) {
  // Read-only actions also support POST so authenticated clients never need to
  // put an ID token in a query string.
  if (data.action === "CheckBatchAssignment") {
    const tankID = String(data.tankID || "").trim();
    const requestedBatch = Number(data.requestedBatch);
    if (!tankID) throw new Error("Missing tankID");
    if (!Number.isFinite(requestedBatch)) throw new Error("Invalid requestedBatch");
    return { success: true, action: "CheckBatchAssignment", result: checkBatchForTank(tankID, requestedBatch) };
  }

  if (data.action === "FindNextBatchForTank") {
    const tankID = String(data.tankID || "").trim();
    const currentBatch = Number(data.currentBatch);
    if (!tankID) throw new Error("Missing tankID");
    if (!Number.isFinite(currentBatch)) throw new Error("Invalid currentBatch");
    return { success: true, action: "FindNextBatchForTank", result: findNextBrewForTankRecursive(tankID, currentBatch) };
  }

  if (data.action === "CheckStatusTransition") {
    const tankID = String(data.tankID || "").trim();
    const toAction = Number(data.toAction);
    if (!tankID) throw new Error("Missing tankID");
    return { success: true, action: "CheckStatusTransition", result: checkStatusTransition(tankID, toAction) };
  }

  if (data.action === "logPackagingToMasterSheet") {
    logToSheet("updating PackagingMasterSheet");
    const result = logPackagingToMasterSheet(data);
    logToSheet("succesfuly updated PackagingMasterSheet");
    return { success: true, result: result };
  }

  if (data.action === "addFermentationMeasurements") {
    logToSheet("Executing addFermentationMeasurements. Count: " + (data.readings ? data.readings.length : 0));
    if (!data.readings || !Array.isArray(data.readings)) throw new Error("Missing or invalid readings array");

    const results = [];
    data.readings.forEach(function (reading) {
      try {
        const result = addFermentationMeasurement(
          reading.sheetUrl,
          reading.temp,
          reading.pressure,
          reading.plato,
          reading.pH,
          reading.carbonation,
          reading.notes,
          reading.boldNotes
        );
        results.push({ success: true, tankId: reading.tankId, tankNumber: reading.tankNumber, result: result });
      } catch (error) {
        logToSheet("addFermentationMeasurements FAILED for tank " + reading.tankNumber + ": " + error.stack);
        results.push({ success: false, tankId: reading.tankId, tankNumber: reading.tankNumber, error: error.message });
      }
    });

    logToSheet("addFermentationMeasurements completed. Success: " +
      results.filter(function (r) { return r.success; }).length + "/" + results.length);

    return { success: true, action: "addFermentationMeasurements", results: results };
  }

  if (data.action === "AssignAndRefreshTank") {
    const result = assignAndRefreshTank(data.fermentorID, data.sheetUrl, data.desiredAction, data.desiredTankStatus);
    return { success: true, action: "AssignAndRefreshTank", result: result };
  }

  if (data.action === "updateTankStatus") {
    updateTankStatus(data.fermentorID, data.tankAction, data.date, data.pasivationDate);
    return {
      success: true,
      action: "updateTankStatus",
      fermentorID: data.fermentorID,
      tankAction: data.tankAction,
      date: data.date,
      pasivationDate: data.pasivationDate
    };
  }

  if (data.action === "assignDryHop") {
    const result = assignDryHopToHopsTable(data.sheetUrl, data.grams, data.hopType, data.aa);
    return { success: true, action: "assignDryHop", result: result };
  }

  if (data.action === "updatePackagingInfo") {
    const result = updatePackagingInfo(
      data.sheetUrl,
      data.isEmpty,
      data.kegs,
      data.crates,
      data.totalLiters,
      data.shrinkagePercent
    );
    return { success: true, action: "updatePackagingInfo", result: result };
  }

  if (data.action === "checkLegacyPackagingCell") {
    const result = checkLegacyPackagingCell(data.sheetUrl, data.cellType);
    return { success: true, action: "checkLegacyPackagingCell", result: result };
  }

  if (data.action === "AssignBatch") {
    const result = assignManualBatch(data.tankID, data.requestedBatch);
    return { success: true, action: "AssignBatch", result: result };
  }

  if (data.action === "refreshSingleTank") {
    const result = refreshSingleTank(data.fermentorID, data.sheetUrl);
    return { success: true, action: "refreshSingleTank", result: result };
  }

  if (data.action === "addFermentationMeasurement") {
    const result = addFermentationMeasurement(
      data.sheetUrl,
      data.temp,
      data.pressure,
      data.plato,
      data.pH,
      data.carbonation,
      data.notes,
      data.boldNotes
    );
    return { success: true, action: "addFermentationMeasurement", result: result };
  }

  if (data.action === "triggerTankUpdate") {
    const result = runFermentorCycle();
    return { success: true, action: "triggerTankUpdate", result: result };
  }

  throw new Error("Unknown action: " + data.action);
}


function checkBatchForTank(tankNumber, requestedBatch) {
  const targetTank = normalizeTankNumber(tankNumber);
  const targetBatch = Number(requestedBatch);

  if (!targetTank) throw new Error("Invalid tank number");
  if (!Number.isFinite(targetBatch)) throw new Error("Invalid batch number");

  logToSheet("Checking batch " + targetBatch + " for tank " + targetTank);

  const rootFolder = DriveApp.getFolderById(BREW_FOLDER_ID);
  const files = [];
  collectGoogleSheetsRecursive(rootFolder, files);

  const candidates = [];
  files.forEach(function (file) {
    const fileName = file.getName();
    const batchFromFilename = extractBatchFromFilename(fileName);
    if (batchFromFilename !== null && batchFromFilename === targetBatch) candidates.push(file);
  });

  if (candidates.length === 0) {
    return {
      valid: false,
      warning: true,
      reason: "Batch not found",
      requestedBatch: String(targetBatch),
      tankNumber: targetTank
    };
  }

  for (let i = 0; i < candidates.length; i++) {
    const file = candidates[i];
    const fileName = file.getName();
    let brew;

    try {
      brew = extractBrew(file.getId());
    } catch (error) {
      logToSheet("extractBrew failed: " + error.message);
      continue;
    }

    if (!brew) continue;

    const actualTank = normalizeTankNumber(brew.tankNumber);

    if (tankNumbersEqual(actualTank, targetTank)) {
      return {
        valid: true,
        warning: false,
        batchNumber: String(targetBatch),
        tankNumber: targetTank,
        beerStyle: brew.beerStyle,
        brewDate: brew.brewDate,
        beerVolume: brew.beerVolume,
        startingPlato: brew.startingPlato,
        sheetUrl: file.getUrl(),
        fileId: file.getId(),
        fileName: fileName
      };
    }

    return {
      valid: false,
      warning: true,
      reason: "Batch belongs to a different tank",
      requestedBatch: String(targetBatch),
      requestedTank: targetTank,
      actualTank: actualTank,
      beerStyle: brew.beerStyle,
      brewDate: brew.brewDate,
      sheetUrl: file.getUrl(),
      fileId: file.getId(),
      fileName: fileName
    };
  }

  return {
    valid: false,
    warning: true,
    reason: "Could not read batch sheet",
    requestedBatch: String(targetBatch),
    tankNumber: targetTank
  };
}

// formatMeasurementValue() is owned by addFermentationMeasurement.js.

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


function updateTankStatus(fermentorID, action, date, pasivationDate) {
  if (!fermentorID) throw new Error("Missing fermentorID");
  if (action === undefined || action === null) throw new Error("Missing tank action");
  if (!date) throw new Error("Missing date");

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(String(fermentorID)) +
    "?updateMask.fieldPaths=action" +
    "&updateMask.fieldPaths=date" +
    "&updateMask.fieldPaths=pasivationDate";

  const fields = {
    action: { integerValue: String(action) },
    date: { timestampValue: new Date(date).toISOString() }
  };

  if (pasivationDate) {
    fields.pasivationDate = { timestampValue: new Date(pasivationDate + "T00:00:00").toISOString() };
  } else {
    fields.pasivationDate = { nullValue: null };
  }

  const firestoreDocument = { fields: fields };

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(firestoreDocument),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error("Firebase update failed: " + code + " " + body);
  }
}
