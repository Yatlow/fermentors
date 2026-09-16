// ============================================================
// SHEETS -> FIRESTORE FRESHNESS
// ============================================================
// The browser can know exactly when app-originated writes reach Sheets via the
// sheetSyncJobs outbox. The reverse direction is polling, not realtime: the
// five-minute fermentor cycle reads every configured active Sheet. Persist the
// outcome of that read cycle so the UI can show how fresh the Sheet-derived
// state actually is without pretending there is a live Sheet listener.

const SHEET_PULL_STATUS_DOCUMENT_ID = "_sheetPullStatus";

function countConfiguredSheetSnapshots_(fermentors) {
  const ids = {};

  (fermentors || []).forEach(function (entry) {
    const sheetUrl = String(entry && entry.data && entry.data.sheetUrl || "").trim();
    if (!sheetUrl) return;

    try {
      ids[extractSpreadsheetId(sheetUrl)] = true;
    } catch (error) {
      // A malformed URL should still count as a configured Sheet. The cycle will
      // report the corresponding sync error/short read instead of looking healthy.
      ids["invalid:" + sheetUrl] = true;
    }
  });

  return Object.keys(ids).length;
}

function recordSheetPullFreshness_(projectId, details) {
  const data = details || {};
  const configuredSheets = Number(data.configuredSheets) || 0;
  const sheetsRead = Number(data.sheetsRead) || 0;
  const syncErrors = Number(data.syncErrors) || 0;
  const measurementErrors = Number(data.measurementErrors) || 0;
  const packagingErrors = Number(data.packagingErrors) || 0;
  const errorCount = syncErrors + measurementErrors + packagingErrors;

  const status =
    errorCount === 0 && sheetsRead >= configuredSheets
      ? "ok"
      : "partial";

  const payload = {
    direction: "sheets_to_firestore",
    state: status,
    startedAt: data.startedAt instanceof Date ? data.startedAt : new Date(data.startedAt || Date.now()),
    completedAt: new Date(),
    configuredSheets: configuredSheets,
    sheetsRead: sheetsRead,
    syncErrors: syncErrors,
    measurementErrors: measurementErrors,
    packagingErrors: packagingErrors,
    errorCount: errorCount
  };

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/sheetSyncJobs/" +
    encodeURIComponent(SHEET_PULL_STATUS_DOCUMENT_ID);

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify({ fields: toFirestoreFields(payload) }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Sheet pull freshness write failed: " +
      code +
      " " +
      response.getContentText()
    );
  }

  return payload;
}
