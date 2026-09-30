// ============================================================
// SYNC HISTORICAL MEASUREMENTS FOR ACTIVE BREWS ONLY
// ============================================================
//
// Only brews that are currently inside a fermentor.
// Historical reconciliation also removes stale same-day Firestore documents
// when a Sheet row was deleted/recreated and therefore received a new time.
//
// Firestore cost guard: a full historical reconciliation is only required after
// the fermentation measurement table itself changed. Changes elsewhere in the
// brew Sheet no longer trigger Firestore reads for every historical row.
// ============================================================

const HISTORICAL_SYNC_REVISION_PREFIX = "historical_measurements_hash_v2:";

function historicalMeasurementDayFromId_(id) {
  const match = String(id || "").match(/^(\d{4}-\d{2}-\d{2})(?:_\d{4})?$/);
  return match ? match[1] : null;
}

function historicalMeasurementsSnapshot_(sheetUrl) {
  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
  const headerRow = findRowContaining(values, "טמפרטורה");
  const rows = [];

  if (headerRow === -1) {
    return { rows: rows, hash: computeHash_(rows) };
  }

  for (let r = headerRow + 1; r < values.length; r++) {
    const dateText = String(values[r][0] || "").trim();
    if (!parseIsraeliDate(dateText)) continue;

    const row = values[r].slice(0, 8).map(function (value) {
      return String(value || "").trim();
    });

    if (!row.slice(2).some(function (value) { return value !== ""; })) continue;
    rows.push(row);
  }

  return { rows: rows, hash: computeHash_(rows) };
}

function historicalSyncRevisionKey_(batchNumber) {
  return HISTORICAL_SYNC_REVISION_PREFIX + String(batchNumber || "").replace("#", "").trim();
}

function historicalCanonicalIdsFromRows_(rows) {
  const canonicalByDay = {};

  rows.forEach(function (row) {
    const date = parseIsraeliDate(row[0]);
    if (!date) return;

    const measurementId = createMeasurementId(date, row[1]);
    const day = historicalMeasurementDayFromId_(measurementId);
    if (day) canonicalByDay[day] = measurementId;
  });

  return canonicalByDay;
}

function listHistoricalMeasurementIds_(projectId, batchNumber) {
  const ids = [];
  let pageToken = null;

  do {
    let url = "https://firestore.googleapis.com/v1/projects/" +
      projectId +
      "/databases/(default)/documents/brews/" +
      encodeURIComponent(batchNumber) +
      "/measurements?pageSize=300";

    if (pageToken) {
      url += "&pageToken=" + encodeURIComponent(pageToken);
    }

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error("List historical measurements failed: " + code + " " + response.getContentText());
    }

    const payload = JSON.parse(response.getContentText());
    (payload.documents || []).forEach(function (document) {
      const name = String(document.name || "");
      const match = name.match(/\/measurements\/([^/]+)$/);
      if (match) ids.push(decodeURIComponent(match[1]));
    });
    pageToken = payload.nextPageToken || null;
  } while (pageToken);

  return ids;
}

function deleteHistoricalMeasurement_(projectId, batchNumber, measurementId) {
  const url = "https://firestore.googleapis.com/v1/projects/" +
    projectId +
    "/databases/(default)/documents/brews/" +
    encodeURIComponent(batchNumber) +
    "/measurements/" +
    encodeURIComponent(measurementId);

  const response = UrlFetchApp.fetch(url, {
    method: "delete",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 404 && (code < 200 || code >= 300)) {
    throw new Error("Delete duplicate historical measurement failed: " + code + " " + response.getContentText());
  }
}

function dedupeHistoricalMeasurementsForBatch_(projectId, batchNumber, measurementRows) {
  const canonicalByDay = historicalCanonicalIdsFromRows_(measurementRows);
  const ids = listHistoricalMeasurementIds_(projectId, batchNumber);
  let deleted = 0;

  ids.forEach(function (measurementId) {
    const day = historicalMeasurementDayFromId_(measurementId);
    if (!day) return;
    const canonicalId = canonicalByDay[day];
    if (!canonicalId || canonicalId === measurementId) return;

    deleteHistoricalMeasurement_(projectId, batchNumber, measurementId);
    deleted++;
    Logger.log("DELETED duplicate same-day measurement: " + measurementId + " -> keep " + canonicalId);
  });

  return deleted;
}

function touchHistoricalMeasurementRevision_(projectId, fermentorId) {
  const url = "https://firestore.googleapis.com/v1/projects/" +
    projectId +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(fermentorId) +
    "?updateMask.fieldPaths=measurementsRevision";

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      fields: {
        measurementsRevision: { stringValue: Utilities.getUuid() }
      }
    }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Historical measurement revision update failed: " + code + " " + response.getContentText());
  }
}

function syncActiveHistoricalMeasurements() {

  const projectId = FIREBASE_PROJECT_ID;
  const properties = PropertiesService.getScriptProperties();

  Logger.log("========================================");
  Logger.log("START ACTIVE HISTORICAL MEASUREMENTS SYNC");

  const fermentors = getAllFermentorsFromFirestore(projectId);

  Logger.log("Fermentors found: " + fermentors.length);

  let processed = 0;
  let skipped = 0;
  let unchanged = 0;
  let failed = 0;
  let duplicateDeletes = 0;

  // ==========================================================
  // PROCESS CURRENTLY ACTIVE FERMENTORS
  // ==========================================================

  fermentors.forEach(function (fermentor) {
    const fermentorId = fermentor.id;

    try {
      const data = fermentor.data || {};

      // ------------------------------------------------------
      // ONLY FERMENTORS WITH ACTIVE BREW
      // ------------------------------------------------------

      const batchNumber = String(data.batchNumber || "").trim();

      if (!batchNumber) {
        Logger.log("SKIPPED " + fermentorId + " - no active batch.");
        skipped++;
        return;
      }

      // ------------------------------------------------------
      // SHEET URL
      // ------------------------------------------------------

      const sheetUrl = String(data.sheetUrl || "").trim();

      if (!sheetUrl) {
        Logger.log("SKIPPED " + fermentorId + " - no sheetUrl.");
        skipped++;
        return;
      }

      // ------------------------------------------------------
      // CHANGE GUARD
      // ------------------------------------------------------

      const revisionKey = historicalSyncRevisionKey_(batchNumber);
      const measurementSnapshot = historicalMeasurementsSnapshot_(sheetUrl);
      const measurementHash = measurementSnapshot.hash;
      const previousHash = properties.getProperty(revisionKey);

      if (previousHash === measurementHash) {
        unchanged++;
        Logger.log("UNCHANGED fermentation measurements: " + batchNumber + " - no Firestore reconciliation needed.");
        return;
      }

      // ------------------------------------------------------
      // UPLOAD + RECONCILE HISTORICAL MEASUREMENTS
      // ------------------------------------------------------

      Logger.log("Syncing historical measurements for batch " + batchNumber + " in fermentor " + fermentorId);

      uploadHistoricalMeasurements(projectId, batchNumber, sheetUrl);

      duplicateDeletes += dedupeHistoricalMeasurementsForBatch_(
        projectId,
        batchNumber,
        measurementSnapshot.rows
      );

      // The Sheet changed since the previous successful reconciliation. Bump
      // the revision once so open clients invalidate their measurement cache.
      touchHistoricalMeasurementRevision_(projectId, fermentorId);

      // Mark only after the complete upload/dedupe/revision sequence succeeded.
      properties.setProperty(revisionKey, measurementHash);

      processed++;
      Logger.log("Historical measurements synced: " + batchNumber);

    } catch (error) {
      failed++;
      Logger.log("ERROR historical sync for fermentor " + fermentorId + ": " + error.message);
    }
  });

  // ==========================================================
  // SUMMARY
  // ==========================================================

  Logger.log("========================================");
  Logger.log("ACTIVE HISTORICAL SYNC FINISHED");
  Logger.log("Processed changed sheets: " + processed);
  Logger.log("Unchanged sheets skipped: " + unchanged);
  Logger.log("Other skipped: " + skipped);
  Logger.log("Failed: " + failed);
  Logger.log("Duplicate same-day documents deleted: " + duplicateDeletes);
  Logger.log("========================================");
}
