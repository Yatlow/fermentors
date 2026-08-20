// ================================================================
// OPTIMIZED FERMENTOR SYNC — reduces Firestore reads/writes
// ================================================================
//
// THE CORE IDEA:
//
// Firestore's 50K/day quota counts READS. batching (batchGet/
// batchWrite) reduces network calls, but each document inside a
// batch is STILL counted as one read/write. So the real fix is:
//
//   1. Fetch each collection ONCE per cycle (not once per service).
//   2. Never call Firestore just to "check if something changed" —
//      keep a local hash in PropertiesService instead. That check
//      costs ZERO Firestore quota.
//   3. Only write to Firestore when the local hash says something
//      actually changed.
//   4. Historical measurements: only touch batches that are
//      currently assigned to a fermentor, and only once a day
//      (except the newest reading, which is already updated by
//      the 5-minute cycle via `currentData` on the fermentor doc).
//
// ================================================================


// ================================================================
// LOCAL CHANGE-DETECTION CACHE (costs 0 Firestore reads/writes)
// ================================================================

/**
 * Returns a short stable hash for any JS value.
 */
function computeHash_(value) {

  const json = JSON.stringify(value);

  const digestBytes =
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5,
      json,
      Utilities.Charset.UTF_8
    );

  return digestBytes
    .map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0"))
    .join("");
}

/**
 * Compares `value` against the last hash stored under `key`.
 * Returns true (and updates the stored hash) only if it changed.
 *
 * This replaces "GET from Firestore, then compare" everywhere.
 * It costs nothing against the Firestore quota.
 */
function hasChangedLocally_(key, value) {

  const props = PropertiesService.getScriptProperties();

  const newHash = computeHash_(value);
  const oldHash = props.getProperty(key);

  if (oldHash === newHash) {
    return false;
  }

  props.setProperty(key, newHash);
  return true;
}

/**
 * Optional: clears all cached hashes. Useful if you ever want to
 * force a full re-check (e.g. after manually editing data in
 * Firestore directly).
 */
function resetChangeCache() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log("Change-detection cache cleared.");
}


// ================================================================
// UNIFIED 5-MINUTE CYCLE
// ================================================================
//
// Replaces having syncAllFermentors() and brewActionService() each
// run on their own trigger (each doing its own separate `list`
// call). Now there is ONE list call per cycle, shared by both.
//
// ================================================================

function runFermentorCycle() {

  Logger.log("========================================");
  Logger.log("START FERMENTOR CYCLE");
  const startTime = new Date();

  const projectId = FIREBASE_PROJECT_ID;

  // ------------------------------------------------------------
  // ONE list call for the whole cycle
  // ------------------------------------------------------------

  const fermentors = getAllFermentorsFromFirestore(projectId);

  Logger.log("Fermentors fetched once: " + fermentors.length);

  // ------------------------------------------------------------
  // STEP 1 — sheet -> fermentor doc sync (current data + status)
  // ------------------------------------------------------------

  const syncStats = syncFermentorsFromSheets_(projectId, fermentors);

  // ------------------------------------------------------------
  // STEP 2 — action-flow state machine (reuses the SAME array;
  // note statuses may be slightly stale from step 1's writes,
  // which is fine — the flow just resolves one step per cycle)
  // ------------------------------------------------------------

  const actionStats = runActionFlow_(fermentors);

  const duration = (new Date().getTime() - startTime.getTime()) / 1000;

  Logger.log("========================================");
  Logger.log("CYCLE FINISHED in " + duration + "s");
  Logger.log("Sync -> updated: " + syncStats.updated + ", skipped: " + syncStats.skipped + ", errors: " + syncStats.errors);
  Logger.log("Action -> a0: " + actionStats.a0 + ", a1: " + actionStats.a1 + ", a5: " + actionStats.a5);
  Logger.log("========================================");
}


// ================================================================
// STEP 1 — SYNC SHEETS INTO FERMENTOR DOCS (cache-based skip)
// ================================================================


function syncFermentorsFromSheets_(projectId, fermentors) {
 
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let latestMeasurementWrites = 0;
 
  fermentors.forEach(function (fermentor) {
 
    const fermentorId = fermentor.id;
 
    try {
 
      const sheetUrl = fermentor.data.sheetUrl;
 
      if (!sheetUrl) {
        skippedCount++;
        return;
      }
 
      const brew = extractBrew(sheetUrl);
 
      if (!brew || !brew.tankNumber) {
        skippedCount++;
        return;
      }
 
      const newData = {
        tankNumber: String(brew.tankNumber).trim(),
        tankStatus: brew.tankStatus === "TRUE",
        batchNumber: brew.batchNumber || null,
        beerStyle: brew.beerStyle || null,
        brewDate: brew.brewDate || null,
        beerVolume: brew.beerVolume || null,
        currentData: brew.currentData || null,
        sheetUrl: brew.sheetUrl || null,
        uid: fermentorId,
        startingPlato: brew.startingPlato || null
      };
 
      const cacheKey = "fermentor:" + fermentorId;
      const fermentorChanged = hasChangedLocally_(cacheKey, newData);
 
      // ----------------------------------------------------------
      // NEW: independent of whether the fermentor doc itself
      // changed, check whether the LATEST measurement changed and
      // if so, write it immediately as its own measurement doc.
      // Uses the SAME per-row cache key scheme as
      // uploadHistoricalMeasurementsCached_, so the daily sync
      // will correctly see it as already-written (no double work).
      // ----------------------------------------------------------
 
      if (newData.batchNumber) {
        try {
          const wrote = writeLatestMeasurementIfChanged_(
            projectId,
            newData.batchNumber,
            sheetUrl
          );
          if (wrote) latestMeasurementWrites++;
        } catch (measurementError) {
          Logger.log(
            "ERROR writing latest measurement for fermentor " +
            fermentorId + ": " + measurementError.message
          );
        }
      }
 
      if (!fermentorChanged) {
        skippedCount++;
        return;
      }
 
      newData.updatedAt = new Date();
 
      updateFermentorDocument(projectId, fermentorId, newData);
 
      updatedCount++;
 
    } catch (error) {
 
      errorCount++;
      Logger.log("ERROR syncing fermentor " + fermentorId + ": " + error.message);
    }
  });
 
  return {
    updated: updatedCount,
    skipped: skippedCount,
    errors: errorCount,
    latestMeasurementWrites: latestMeasurementWrites
  };
}
 
 
 
function writeLatestMeasurementIfChanged_(projectId, batchId, sheetUrl) {
 
  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
 
  const headerRow = findRowContaining(values, "טמפרטורה");
 
  if (headerRow === -1) {
    return false;
  }
 
  // ------------------------------------------------------------
  // Walk from the bottom up and take the first row that has a
  // parseable date AND at least one measurement value — that's
  // "the latest measurement" the same way findLatestAvailableMeasurements
  // effectively does for currentData.
  // ------------------------------------------------------------
 
  for (let r = values.length - 1; r > headerRow; r--) {
 
    const dateText = String(values[r][0] || "").trim();
    const date = parseIsraeliDate(dateText);
 
    if (!date) continue;
 
    const hasAnyValue =
      values[r][2] || values[r][3] || values[r][4] ||
      values[r][5] || values[r][6] || values[r][7];
 
    if (!hasAnyValue) continue;
 
    const time = String(values[r][1] || "").trim();
 
    const measurement = {
      date: dateText,
      time: time,
      temp: extractNumber(values[r][3]),
      plato: extractNumber(values[r][2]),
      pressure: extractNumber(values[r][4]),
      carbonation: extractNumber(values[r][6]),
      pH: extractNumber(values[r][5]),
      notes: String(values[r][7] || "").trim()
    };
 
    const measurementId = createMeasurementId(date, time);
 
    // Same cache key namespace as the daily sync, so whichever
    // job (5-min or daily) sees it first "claims" it — the other
    // will correctly skip it as unchanged.
    const cacheKey = "measurement:" + batchId + ":" + measurementId;
 
    if (!hasChangedLocally_(cacheKey, measurement)) {
      return false;
    }
 
    const docPath =
      "projects/" + projectId +
      "/databases/(default)/documents/brews/" +
      encodeURIComponent(batchId) +
      "/measurements/" +
      encodeURIComponent(measurementId);
 
    const url =
      "https://firestore.googleapis.com/v1/projects/" +
      projectId +
      "/databases/(default)/documents/brews/" +
      encodeURIComponent(batchId) +
      "/measurements/" +
      encodeURIComponent(measurementId);
 
    const response = UrlFetchApp.fetch(url, {
      method: "patch",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ fields: toFirestoreFields(measurement) }),
      muteHttpExceptions: true
    });
 
    const code = response.getResponseCode();
 
    if (code < 200 || code >= 300) {
      throw new Error(
        "Latest-measurement write failed for batch " + batchId + ": " +
        code + " " + response.getContentText()
      );
    }
 
    Logger.log("Wrote latest measurement immediately: " + docPath);
    return true;
  }
 
  return false;
}


// ================================================================
// STEP 2 — ACTION-FLOW STATE MACHINE (same logic, shared array)
// ================================================================

function runActionFlow_(fermentors) {

  let a0 = 0, a1 = 0, a5 = 0;

  fermentors.forEach(function (fermentorEntry) {

    // fermentorEntry looks like { id, data }. The action-flow
    // functions (processAction0/1/5) expect a flat object with
    // tankNumber/action/etc — normalize it here.

    const fermentor = Object.assign(
      { uid: fermentorEntry.id },
      fermentorEntry.data
    );

    const action = parseAction(fermentor.action);

    try {

      if (action === 0) { a0++; processAction0(fermentor); return; }
      if (action === 1) { a1++; processAction1(fermentor); return; }
      if (action === 5) { a5++; processAction5(fermentor); return; }
      // action 3 / 4 -> waiting for GUI, nothing to do here.

    } catch (error) {

      Logger.log("ERROR action-flow for tank " + fermentor.tankNumber + ": " + error.message);
    }
  });

  return { a0: a0, a1: a1, a5: a5 };
}


// ================================================================
// DAILY HISTORICAL SYNC — ACTIVE BATCHES ONLY, CACHE-BASED SKIP
// ================================================================
//
// Only touches batches that are CURRENTLY assigned to a fermentor.
// Never touches historical measurements for unassigned batches.
//
// Uses the local hash cache instead of a Firestore GET per row,
// so unchanged rows cost 0 reads. Only rows that actually changed
// get written (and writes are still sent via :batchWrite in one
// HTTP call per brew instead of one call per row).
//
// ================================================================

function dailyHistoricalSync() {

  Logger.log("========================================");
  Logger.log("START DAILY HISTORICAL SYNC (active batches only)");

  const projectId = FIREBASE_PROJECT_ID;

  const fermentors = getAllFermentorsFromFirestore(projectId);

  let processed = 0;
  let skippedInactive = 0;
  let failed = 0;

  fermentors.forEach(function (fermentor) {

    const data = fermentor.data || {};

    const batchNumber = String(data.batchNumber || "").trim();
    const sheetUrl = String(data.sheetUrl || "").trim();

    if (!batchNumber || !sheetUrl) {
      skippedInactive++;
      return;
    }

    try {

      uploadHistoricalMeasurementsCached_(projectId, batchNumber, sheetUrl);
      processed++;

    } catch (error) {

      failed++;
      Logger.log("ERROR historical sync for batch " + batchNumber + ": " + error.message);
    }
  });

  Logger.log("Processed active batches: " + processed);
  Logger.log("Skipped (no active batch): " + skippedInactive);
  Logger.log("Failed: " + failed);
  Logger.log("========================================");
}


/**
 * Same job as the original uploadHistoricalMeasurements(), but:
 *  - skips rows using a LOCAL hash cache (0 Firestore reads)
 *  - sends all real writes for this brew in a single :batchWrite
 *    call instead of one PATCH per row.
 */
function uploadHistoricalMeasurementsCached_(projectId, batchId, sheetUrl) {

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();

  const headerRow = findRowContaining(values, "טמפרטורה");

  if (headerRow === -1) {
    Logger.log("No fermentation table found for batch " + batchId);
    return;
  }

  const writes = []; // Firestore "writes" entries for :batchWrite
  let skippedCount = 0;

  for (let r = headerRow + 1; r < values.length; r++) {

    const dateText = String(values[r][0] || "").trim();
    const date = parseIsraeliDate(dateText);

    if (!date) continue;

    const time = String(values[r][1] || "").trim();

    if (!values[r][2] && !values[r][3] && !values[r][4] &&
        !values[r][5] && !values[r][6] && !values[r][7]) {
      continue;
    }

    const measurement = {
      date: dateText,
      time: time,
      temp: extractNumber(values[r][3]),
      plato: extractNumber(values[r][2]),
      pressure: extractNumber(values[r][4]),
      carbonation: extractNumber(values[r][6]),
      pH: extractNumber(values[r][5]),
      notes: String(values[r][7] || "").trim()
    };

    const measurementId = createMeasurementId(date, time);

    // ----------------------------------------------------------
    // LOCAL cache check — replaces the per-row Firestore GET.
    // ----------------------------------------------------------

    const cacheKey = "measurement:" + batchId + ":" + measurementId;

    if (!hasChangedLocally_(cacheKey, measurement)) {
      skippedCount++;
      continue;
    }

    const docPath =
      "projects/" + projectId +
      "/databases/(default)/documents/brews/" +
      encodeURIComponent(batchId) +
      "/measurements/" +
      encodeURIComponent(measurementId);

    writes.push({
      update: {
        name: docPath,
        fields: toFirestoreFields(measurement)
      }
    });
  }

  Logger.log(
    "Batch " + batchId + " — changed rows: " + writes.length +
    " | unchanged (skipped, 0 reads): " + skippedCount
  );

  if (writes.length === 0) {
    return;
  }

  // ------------------------------------------------------------
  // Send ALL changed rows for this brew in ONE :batchWrite call.
  // (Still N writes against quota, but 1 HTTP round-trip instead
  // of N — faster and avoids Apps Script's own URLFetch limits.)
  // Firestore's batchWrite caps at 500 writes per call.
  // ------------------------------------------------------------

  const chunkSize = 500;

  for (let i = 0; i < writes.length; i += chunkSize) {

    const chunk = writes.slice(i, i + chunkSize);

    const url =
      "https://firestore.googleapis.com/v1/projects/" +
      projectId +
      "/databases/(default)/documents:batchWrite";

    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ writes: chunk }),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();

    if (code < 200 || code >= 300) {
      throw new Error(
        "batchWrite failed for batch " + batchId + ": " +
        code + " " + response.getContentText()
      );
    }
  }

  Logger.log("Batch " + batchId + " — wrote " + writes.length + " changed measurement(s).");
}


// ================================================================
// TRIGGER SETUP — run each ONCE manually
// ================================================================

function setupOptimizedTriggers() {

  // Remove old/duplicate triggers for all related functions
  const namesToClear = [
    "syncAllFermentors",
    "brewActionService",
    "dailyBrewSyncService",
    "syncActiveHistoricalMeasurements",
    "runFermentorCycle",
    "dailyHistoricalSync"
  ];

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (namesToClear.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // One 5-minute cycle (sync + action flow together)
  ScriptApp.newTrigger("runFermentorCycle")
    .timeBased()
    .everyMinutes(5)
    .create();

  // One daily historical sync, active batches only
  ScriptApp.newTrigger("dailyHistoricalSync")
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  Logger.log("Triggers set: runFermentorCycle every 5 min, dailyHistoricalSync daily at ~03:00.");
}


// ================================================================
// MANUAL TESTS
// ================================================================

function testRunFermentorCycle() {
  runFermentorCycle();
}

function testDailyHistoricalSync() {
  dailyHistoricalSync();
}

