// ============================================================
// GLOBAL LOGGING
// ============================================================
// Request diagnostics are buffered during the Web App call and persisted only
// to ScriptProperties before returning. A scheduled cellar cycle later flushes
// the queued rows to the shared Logs sheet. This preserves the operational log
// without putting SpreadsheetApp.openById() on the user's response path.
// ============================================================

const LOG_SHEET_ID = "1Uoenz65Dx0inv3r6ZR4hCiF4JMx0U0BHG7W5tsfG8mc";
const ASYNC_LOG_PREFIX = "async_log_v1:";
const ASYNC_LOG_MAX_KEYS_PER_FLUSH = 100;

let _logBuffer = [];

function logToSheet(message) {
  const text = String(message);
  console.log(text);
  _logBuffer.push([new Date(), text]);
}

function enqueueLogs_() {
  if (_logBuffer.length === 0) return;

  const rows = _logBuffer.map(function (row) {
    const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return [date.toISOString(), String(row[1] || "")];
  });

  const key = ASYNC_LOG_PREFIX + Date.now() + ":" + Utilities.getUuid();

  try {
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(rows));
  } catch (error) {
    console.log("enqueueLogs_ FAILED: " + error.message);
  } finally {
    _logBuffer = [];
  }
}

function flushQueuedLogs_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const keys = Object.keys(all)
    .filter(function (key) { return key.indexOf(ASYNC_LOG_PREFIX) === 0; })
    .sort()
    .slice(0, ASYNC_LOG_MAX_KEYS_PER_FLUSH);

  if (keys.length === 0) return { flushedRows: 0, flushedKeys: 0 };

  const rows = [];
  const validKeys = [];

  keys.forEach(function (key) {
    try {
      const parsed = JSON.parse(all[key]);
      if (!Array.isArray(parsed)) {
        props.deleteProperty(key);
        return;
      }

      parsed.forEach(function (row) {
        if (!Array.isArray(row) || row.length < 2) return;
        rows.push([new Date(row[0]), String(row[1] || "")]);
      });
      validKeys.push(key);
    } catch (error) {
      console.log("Invalid queued log payload " + key + ": " + error.message);
      props.deleteProperty(key);
    }
  });

  if (rows.length === 0) {
    validKeys.forEach(function (key) { props.deleteProperty(key); });
    return { flushedRows: 0, flushedKeys: validKeys.length };
  }

  const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
  const sheet = ss.getSheetByName("Logs") || ss.insertSheet("Logs");
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, 2).setValues(rows);

  validKeys.forEach(function (key) { props.deleteProperty(key); });

  console.log(
    "flushQueuedLogs_: rows=" + rows.length +
    " keys=" + validKeys.length
  );

  return { flushedRows: rows.length, flushedKeys: validKeys.length };
}

// Compatibility wrapper for old/manual callers. It now queues instead of
// touching the Logs spreadsheet synchronously.
function flushLogs_() {
  enqueueLogs_();
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
  ApplyManualStatus: true,
  updateTankStatus: true,
  assignDryHop: true,
  updatePackagingInfo: true,
  AssignBatch: true,
  refreshSingleTank: true,
  addFermentationMeasurement: true,
  triggerTankUpdate: true,
  manualNightSync: true,
  BrewSheetCreate: true,
  BrewSheetWriteCells: true,
  BrewSheetTrash: true
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

    if (!existing || existing.state !== "in_progress") return null;
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
      if (!savedAt || now - savedAt > POST_IDEMPOTENCY_TTL_MS) props.deleteProperty(key);
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
    return Object.assign({}, claim.response, { duplicate: true, requestId: requestId });
  }

  if (claim.state === "in_progress") {
    logToSheet("IDEMPOTENCY WAIT: " + action + " requestId=" + requestId);
    const waitedResponse = postWaitForIdempotencyResult_(claim.key);

    if (waitedResponse) {
      return Object.assign({}, waitedResponse, { duplicate: true, requestId: requestId });
    }

    throw new Error("Request is already being processed. Please retry shortly.");
  }

  try {
    const response = executePostAction_(data);
    const persistedResponse = Object.assign({}, response, { requestId: requestId });
    postSaveIdempotencyResult_(claim.key, action, requestId, persistedResponse);
    postCleanupIdempotencyCache_();
    return persistedResponse;
  } catch (error) {
    postReleaseFailedIdempotencyClaim_(claim.key);
    throw error;
  }
}


// Direct GET calls are intentionally closed. Authenticated reads use POST so
// Firebase ID tokens never appear in URLs/query strings.
function doGet() {
  return jsonResponse({
    success: false,
    error: "Unauthorized"
  });
}


function doPost(e) {
  const startTime = Date.now();

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No POST data received");
    }

    const data = JSON.parse(e.postData.contents);

    const authenticatedUser = authenticateFirebaseRequest_(data.idToken);
    delete data.idToken;

    logToSheet(
      "Authenticated action: " + data.action +
      " user=" + authenticatedUser.email +
      " requestId=" + String(data.requestId || "none")
    );

    const response = runPostActionIdempotently_(data);

    // Kept as a no-op compatibility hook. Successful mutations are confirmed
    // through one idempotent retry when Google's ContentService loses JSON.
    writeOperationReceipt_(data, response, authenticatedUser);

    return jsonResponse(response);
  } catch (error) {
    const message =
      error && (error.message === "Unauthorized" || error.message === "Forbidden")
        ? error.message
        : (error && error.message ? error.message : "Request failed");

    logToSheet("doPost ERROR: " + message);
    return jsonResponse({ success: false, error: message });
  } finally {
    logToSheet("Total doPost time: " + (Date.now() - startTime) + "ms");
    enqueueLogs_();
  }
}


function executePostAction_(data) {
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
    const result = logPackagingToMasterSheet(data);
    return { success: true, result: result };
  }

  if (data.action === "addFermentationMeasurements") {
    if (!data.readings || !Array.isArray(data.readings)) throw new Error("Missing or invalid readings array");

    const results = [];
    data.readings.forEach(function (reading) {
      try {
        let result = null;

        if (isNoteOnlyFermentationReading_(reading)) {
          try {
            result = addFermentationNoteViaSheetsApi_(
              reading.sheetUrl,
              reading.notes
            );
          } catch (apiError) {
            logToSheet(
              "Sheets API note fast-path failed for tank " +
              reading.tankNumber + ": " + apiError.message +
              " — falling back to SpreadsheetApp"
            );
          }
        }

        if (!result) {
          result = addFermentationMeasurement(
            reading.sheetUrl,
            reading.temp,
            reading.pressure,
            reading.plato,
            reading.pH,
            reading.carbonation,
            reading.notes,
            reading.boldNotes
          );
        }

        results.push({ success: true, tankId: reading.tankId, tankNumber: reading.tankNumber, result: result });
      } catch (error) {
        logToSheet("addFermentationMeasurements FAILED for tank " + reading.tankNumber + ": " + error.message);
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

  if (data.action === "ApplyManualStatus") {
    const result = applyManualStatusChange(
      data.fermentorID,
      data.desiredAction,
      data.desiredTankStatus,
      data.expectedBatchNumber,
      data.expectedFromAction
    );
    return { success: true, action: "ApplyManualStatus", result: result };
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
    let result = null;
    const singleReading = {
      sheetUrl: data.sheetUrl,
      temp: data.temp,
      pressure: data.pressure,
      plato: data.plato,
      pH: data.pH,
      carbonation: data.carbonation,
      notes: data.notes,
      boldNotes: data.boldNotes
    };

    if (isNoteOnlyFermentationReading_(singleReading)) {
      try {
        result = addFermentationNoteViaSheetsApi_(data.sheetUrl, data.notes);
      } catch (apiError) {
        logToSheet(
          "Sheets API single-note fast-path failed: " + apiError.message +
          " — falling back to SpreadsheetApp"
        );
      }
    }

    if (!result) {
      result = addFermentationMeasurement(
        data.sheetUrl,
        data.temp,
        data.pressure,
        data.plato,
        data.pH,
        data.carbonation,
        data.notes,
        data.boldNotes
      );
    }

    return { success: true, action: "addFermentationMeasurement", result: result };
  }

  if (data.action === "triggerTankUpdate") {
    const result = runFermentorCycle();
    return { success: true, action: "triggerTankUpdate", result: result };
  }

  if (data.action === "manualNightSync") {
    const result = runManualNightFermentorSync_();
    return {
      success: result.success === true,
      action: "manualNightSync",
      result: result,
      message: result.message || undefined
    };
  }

  if (data.action === "BrewSheetCreate") {
    return {
      success: true,
      action: "BrewSheetCreate",
      result: brewingSheetCreate_(data)
    };
  }

  if (data.action === "BrewSheetWriteCells") {
    return {
      success: true,
      action: "BrewSheetWriteCells",
      result: brewingSheetWriteCells_(data)
    };
  }

  if (data.action === "BrewSheetReadRange") {
    return {
      success: true,
      action: "BrewSheetReadRange",
      result: brewingSheetReadRange_(data)
    };
  }

  if (data.action === "BrewSheetTrash") {
    return {
      success: true,
      action: "BrewSheetTrash",
      result: brewingSheetTrash_(data)
    };
  }

  if (data.action === "BrewSheetAcidHistory") {
    return {
      success: true,
      action: "BrewSheetAcidHistory",
      result: brewingSheetAcidHistory_(data)
    };
  }

  if (data.action === "BrewSheetListHistory") {
    return {
      success: true,
      action: "BrewSheetListHistory",
      result: brewingSheetListHistory_(data)
    };
  }

  throw new Error("Unknown action: " + data.action);
}


function checkBatchForTank(tankNumber, requestedBatch) {
  const targetTank = normalizeTankNumber(tankNumber);
  const targetBatch = Number(requestedBatch);

  if (!targetTank) throw new Error("Invalid tank number");
  if (!Number.isFinite(targetBatch)) throw new Error("Invalid batch number");

  // Reuse the same Drive Changes-backed snapshot as ACTION 5 instead of doing
  // a fresh recursive Drive walk for every manual check. The snapshot refreshes
  // immediately when Drive reports changes, but the normal path is a cheap
  // PropertiesService read.
  const candidates = getBrewFolderCandidatesCached().filter(function (candidate) {
    return Number(candidate.batch) === targetBatch;
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

  const brewExtractCache = {};
  let firstMismatch = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    let brew;

    try {
      brew = extractBrewCached(candidate.fileId, brewExtractCache);
    } catch (error) {
      logToSheet("extractBrew failed: " + error.message);
      continue;
    }

    if (!brew) continue;

    const actualTank = normalizeTankNumber(brew.tankNumber);
    const result = {
      batchNumber: String(targetBatch),
      tankNumber: targetTank,
      beerStyle: brew.beerStyle,
      brewDate: brew.brewDate,
      beerVolume: brew.beerVolume,
      startingPlato: brew.startingPlato,
      sheetUrl: buildSheetUrl(candidate.fileId),
      fileId: candidate.fileId,
      fileName: candidate.fileName
    };

    if (tankNumbersEqual(actualTank, targetTank)) {
      return Object.assign({
        valid: true,
        warning: false
      }, result);
    }

    if (!firstMismatch) {
      firstMismatch = Object.assign({
        valid: false,
        warning: true,
        reason: "Batch belongs to a different tank",
        requestedBatch: String(targetBatch),
        requestedTank: targetTank,
        actualTank: actualTank
      }, result);
    }
  }

  if (firstMismatch) return firstMismatch;

  return {
    valid: false,
    warning: true,
    reason: "Could not read batch sheet",
    requestedBatch: String(targetBatch),
    tankNumber: targetTank
  };
}
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

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error("Firebase update failed: " + code + " " + body);
  }
}
