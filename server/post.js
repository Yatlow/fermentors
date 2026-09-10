// ============================================================
// GLOBAL LOGGING (buffered — נכתב פעם אחת בסוף כל בקשה)
// ============================================================

const LOG_SHEET_ID = "1Uoenz65Dx0inv3r6ZR4hCiF4JMx0U0BHG7W5tsfG8mc";

let _logBuffer = [];

function logToSheet(message) {
  // לא כותב לגיליון מיד - רק צובר בזיכרון. מהיר וזול.
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
    // אם הלוגינג עצמו נכשל (למשל בעיית הרשאות לגיליון הלוגים),
    // שלא יפיל את הפעולה האמיתית. אבל שווה לדעת שזה קורה:
    console.log("flushLogs_ FAILED: " + err.message);
  } finally {
    _logBuffer = [];
  }
}


function doGet(e) {

  try {

    logToSheet("GET event: " + JSON.stringify(e));

    if (!e || !e.parameter) {
      throw new Error("No GET parameters received");
    }

    const action = e.parameter.action;

    // ========================================================
    // CHECK BATCH ASSIGNMENT (validate a batch against a tank)
    // ========================================================

    if (action === "CheckBatchAssignment") {

      logToSheet("MANUAL BATCH CHECK");
      const tankID = String(e.parameter.tankID || "").trim();
      const requestedBatch = Number(e.parameter.requestedBatch);

      if (!tankID) {
        throw new Error("Missing tankID");
      }

      if (!Number.isFinite(requestedBatch)) {
        throw new Error("Invalid requestedBatch");
      }

      logToSheet("Tank: " + tankID);
      logToSheet("Requested batch: " + requestedBatch);

      const result = checkBatchForTank(tankID, requestedBatch);

      return jsonResponse({ success: true, result: result });
    }


    // ========================================================
    // FIND NEXT BATCH FOR TANK (is there a "better" batch?)
    // Reuses the same recursive search used by ACTION 5's
    // automatic flow, exposed here for the manual admin tool.
    // ========================================================

    if (action === "FindNextBatchForTank") {

      const tankID = String(e.parameter.tankID || "").trim();
      const currentBatch = Number(e.parameter.currentBatch);

      if (!tankID) {
        throw new Error("Missing tankID");
      }

      if (!Number.isFinite(currentBatch)) {
        throw new Error("Invalid currentBatch");
      }

      logToSheet("FindNextBatchForTank - Tank: " + tankID + ", currentBatch: " + currentBatch);

      const nextBrew = findNextBrewForTankRecursive(tankID, currentBatch);

      logToSheet("FindNextBatchForTank result: " + JSON.stringify(nextBrew));

      return jsonResponse({ success: true, result: nextBrew });
    }

      logToSheet("abc1")
    if (action === "CheckStatusTransition") {
      logToSheet("abc")
      const tankID = String(e.parameter.tankID || "").trim();
      const toAction = Number(e.parameter.toAction);

      if (!tankID) {
        throw new Error("Missing tankID");
      }

      logToSheet("CheckStatusTransition - Tank: " + tankID + ", toAction: " + toAction);

      const result = checkStatusTransition(tankID, toAction);

      return jsonResponse({ success: true, result: result });
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

    logToSheet("RAW postData: " + JSON.stringify(e && e.postData ? e.postData.contents : null));

    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No POST data received");
    }

    const data = JSON.parse(e.postData.contents);

    logToSheet("Action requested: " + data.action);

    if (data.action === "logPackagingToMasterSheet") {
      logToSheet("updating PackagingMasterSheet");
      const result = logPackagingToMasterSheet(data);
      logToSheet("succesfuly updated PackagingMasterSheet");
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, result: result }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ========================================================
    // ADD MULTIPLE FERMENTATION MEASUREMENTS (BATCH)
    // ========================================================

    if (data.action === "addFermentationMeasurements") {

      logToSheet("Executing addFermentationMeasurements. Count: " + (data.readings ? data.readings.length : 0));

      if (!data.readings || !Array.isArray(data.readings)) {
        throw new Error("Missing or invalid readings array");
      }

      const results = [];
      // const lock = LockService.getScriptLock();

      data.readings.forEach(function (reading) {

        try {

          // lock.waitLock(30000);

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

          results.push({
            success: true,
            tankId: reading.tankId,
            tankNumber: reading.tankNumber,
            result: result
          });

        } catch (error) {

          logToSheet("addFermentationMeasurements FAILED for tank " + reading.tankNumber + ": " + error.stack);

          results.push({
            success: false,
            tankId: reading.tankId,
            tankNumber: reading.tankNumber,
            error: error.message
          });
        }

        // } finally {

        //   try { lock.releaseLock(); } catch (releaseErr) { /* לא נעול */ }

        // }
      });

      logToSheet("addFermentationMeasurements completed. Success: " +
        results.filter(function (r) { return r.success; }).length +
        "/" + results.length);

      return jsonResponse({
        success: true,
        action: "addFermentationMeasurements",
        results: results
      });
    }


    if (data.action === "AssignAndRefreshTank") {

      logToSheet("Executing AssignAndRefreshTank for Fermentor: " + data.fermentorID);

      const result = assignAndRefreshTank(
        data.fermentorID,
        data.sheetUrl,
        data.desiredAction,
        data.desiredTankStatus
      );

      logToSheet("AssignAndRefreshTank completed: " + JSON.stringify(result));

      return jsonResponse({
        success: true,
        action: "AssignAndRefreshTank",
        result: result
      });
    }
    // ========================================================
    // UPDATE TANK STATUS
    // ========================================================

    if (data.action === "updateTankStatus") {

      logToSheet("Executing updateTankStatus for fermentor: " + data.fermentorID);

      updateTankStatus(
        data.fermentorID,
        data.tankAction,
        data.date,
        data.pasivationDate
      );

      logToSheet("updateTankStatus completed successfully");

      return jsonResponse({
        success: true,
        action: "updateTankStatus",
        fermentorID: data.fermentorID,
        tankAction: data.tankAction,
        date: data.date,
        pasivationDate: data.pasivationDate
      });
    }

    // ========================================================
    // ASSIGN DRY HOP
    // ========================================================

    if (data.action === "assignDryHop") {

      logToSheet("Executing assignDryHop. Type: " + data.hopType + ", Grams: " + data.grams);

      const result = assignDryHopToHopsTable(
        data.sheetUrl,
        data.grams,
        data.hopType
      );

      return jsonResponse({
        success: true,
        action: "assignDryHop",
        result: result
      });
    }

    // ========================================================
    // UPDATE PACKAGING INFO
    // ========================================================

    if (data.action === "updatePackagingInfo") {

      logToSheet("Executing updatePackagingInfo for sheet: " + data.sheetUrl);

      const result = updatePackagingInfo(
        data.sheetUrl,
        data.isEmpty,
        data.kegs,
        data.crates,
        data.totalLiters,
        data.shrinkagePercent
      );

      logToSheet("updatePackagingInfo completed successfully");

      return jsonResponse({
        success: true,
        action: "updatePackagingInfo",
        result: result
      });
    }

    // ========================================================
    // CHECK LEGACY PACKAGING CELL
    // ========================================================

    if (data.action === "checkLegacyPackagingCell") {

      logToSheet("Executing checkLegacyPackagingCell. Type: " + data.cellType);

      const result = checkLegacyPackagingCell(
        data.sheetUrl,
        data.cellType
      );

      logToSheet("checkLegacyPackagingCell result: " + JSON.stringify(result));

      return jsonResponse({
        success: true,
        action: "checkLegacyPackagingCell",
        result: result
      });
    }

    // ========================================================
    // ASSIGN MANUAL BATCH
    // ========================================================

    if (data.action === "AssignBatch") {

      logToSheet("Executing AssignBatch for Tank: " + data.tankID + ", Batch: " + data.requestedBatch);

      const result = assignManualBatch(
        data.tankID,
        data.requestedBatch
      );

      logToSheet("AssignBatch completed with result: " + JSON.stringify(result));

      return jsonResponse({
        success: true,
        action: "AssignBatch",
        result: result
      });
    }

    // ========================================================
    // REFRESH SINGLE TANK
    // ========================================================

    if (data.action === "refreshSingleTank") {

      logToSheet("Executing refreshSingleTank for Fermentor: " + data.fermentorID);

      const result = refreshSingleTank(data.fermentorID, data.sheetUrl);

      logToSheet("refreshSingleTank completed successfully");

      return jsonResponse({
        success: true,
        action: "refreshSingleTank",
        result: result
      });
    }

    // ========================================================
    // ADD FERMENTATION MEASUREMENT TO GOOGLE SHEET (single, legacy)
    // ========================================================

    if (data.action === "addFermentationMeasurement") {

      logToSheet("Executing addFermentationMeasurement for sheet: " + data.sheetUrl);

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

      logToSheet("addFermentationMeasurement completed successfully");

      return jsonResponse({
        success: true,
        action: "addFermentationMeasurement",
        result: result
      });
    }

    // ========================================================
    // TRIGGER TANK UPDATE
    // ========================================================

    if (data.action === "triggerTankUpdate") {

      logToSheet("Executing triggerTankUpdate (runFermentorCycle)");

      const result = runFermentorCycle();

      logToSheet("triggerTankUpdate completed successfully");

      return jsonResponse({
        success: true,
        action: "triggerTankUpdate",
        result: result
      });
    }

    throw new Error("Unknown action: " + data.action);

  } catch (error) {

    logToSheet("doPost ERROR: " + error.stack);
    return jsonResponse({ success: false, error: error.message });

  } finally {
    // רץ תמיד - גם בהצלחה וגם בשגיאה - וגם אם הקוד "נתקע" ומעולם לא הגיע ל-return
    // (למעשה: אם ה-execution עצמו נהרג ע"י Apps Script בגלל timeout, ה-finally הזה
    // כנראה לא ירוץ - אבל בכל מקרה אחר של הצלחה/שגיאה רגילה, זה יבטיח שהלוג נכתב)
    logToSheet("Total doPost time: " + (Date.now() - startTime) + "ms");
    flushLogs_();
  }
}


function checkBatchForTank(tankNumber, requestedBatch) {

  const targetTank = normalizeTankNumber(tankNumber);
  const targetBatch = Number(requestedBatch);

  if (!targetTank) {
    throw new Error("Invalid tank number");
  }

  if (!Number.isFinite(targetBatch)) {
    throw new Error("Invalid batch number");
  }

  logToSheet("Checking batch " + targetBatch + " for tank " + targetTank);

  const rootFolder = DriveApp.getFolderById(BREW_FOLDER_ID);
  const files = [];

  collectGoogleSheetsRecursive(rootFolder, files);

  logToSheet("Google Sheets found: " + files.length);

  const candidates = [];

  files.forEach(function (file) {
    const fileName = file.getName();
    const batchFromFilename = extractBatchFromFilename(fileName);

    if (batchFromFilename === null) {
      return;
    }

    if (batchFromFilename === targetBatch) {
      candidates.push(file);
    }
  });

  if (candidates.length === 0) {

    logToSheet("Batch " + targetBatch + " not found.");

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

    logToSheet("Checking batch file: " + fileName);

    let brew;

    try {
      brew = extractBrew(file.getId());
    } catch (error) {
      logToSheet("extractBrew failed: " + error.message);
      continue;
    }

    if (!brew) {
      continue;
    }

    const actualTank = normalizeTankNumber(brew.tankNumber);

    logToSheet("Requested tank: " + targetTank);
    logToSheet("Actual tank in sheet: " + actualTank);

    if (tankNumbersEqual(actualTank, targetTank)) {

      logToSheet("BATCH IS VALID FOR TANK");

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

    logToSheet("BATCH DOES NOT MATCH TANK");

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

// ============================================================
// FORMAT OPTIONAL MEASUREMENT VALUE
// ============================================================

function formatMeasurementValue(value) {

  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    return "";
  }

  const text = String(value).trim();

  if (!text) {
    return "";
  }

  const normalized = text.replace(",", ".");
  const number = Number(normalized);

  if (Number.isFinite(number)) {
    return number;
  }

  const extracted = extractNumber(text);

  if (extracted !== null) {
    return extracted;
  }

  return text;
}


function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


function updateTankStatus(fermentorID, action, date, pasivationDate) {

  if (!fermentorID) {
    throw new Error("Missing fermentorID");
  }

  if (action === undefined || action === null) {
    throw new Error("Missing tank action");
  }

  if (!date) {
    throw new Error("Missing date");
  }

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
    fields.pasivationDate = {
      timestampValue: new Date(pasivationDate + "T00:00:00").toISOString()
    };
  } else {
    fields.pasivationDate = { nullValue: null };
  }

  const firestoreDocument = { fields: fields };

  logToSheet("Sending to Firebase: " + JSON.stringify(firestoreDocument));

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(firestoreDocument),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  logToSheet("Firebase HTTP status: " + code);
  logToSheet("Firebase response: " + body);

  if (code < 200 || code >= 300) {
    throw new Error("Firebase update failed: " + code + " " + body);
  }

  logToSheet("Updated fermentor: " + fermentorID);
}