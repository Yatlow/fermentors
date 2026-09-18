// ================================================================
// COMPLETED PACKAGING OPERATION RETENTION
// ================================================================
// packagingLog is the permanent business history. packagingOperations is a
// short-lived workflow/recovery record. Completed operations receive a
// cleanupAfter timestamp from the client and are deleted after 30 days.
// Run at most once per Jerusalem calendar day and cap each pass.
// ================================================================

const PACKAGING_CLEANUP_DAY_KEY = "packaging_operations_cleanup_day_v1";
const PACKAGING_CLEANUP_LIMIT = 50;

function packagingCleanupProjectId_() {
  if (typeof FIREBASE_PROJECT_ID !== "undefined" && FIREBASE_PROJECT_ID) {
    return FIREBASE_PROJECT_ID;
  }
  return FIREBASE_AUTH_PROJECT_ID;
}

function packagingCleanupBaseUrl_() {
  return "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(packagingCleanupProjectId_()) +
    "/databases/(default)/documents";
}

function cleanupCompletedPackagingOperations_() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), "Asia/Jerusalem", "yyyy-MM-dd");

  if (props.getProperty(PACKAGING_CLEANUP_DAY_KEY) === today) {
    return { skipped: true, deleted: 0 };
  }

  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(packagingCleanupBaseUrl_() + ":runQuery", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "packagingOperations" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "cleanupAfter" },
            op: "LESS_THAN_OR_EQUAL",
            value: { timestampValue: new Date().toISOString() }
          }
        },
        orderBy: [{
          field: { fieldPath: "cleanupAfter" },
          direction: "ASCENDING"
        }],
        limit: PACKAGING_CLEANUP_LIMIT
      }
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Packaging operation cleanup query failed: HTTP " + code);
  }

  const rows = JSON.parse(response.getContentText() || "[]");
  const names = rows
    .map(function (row) { return row.document && row.document.name; })
    .filter(Boolean);

  let deleted = 0;
  names.forEach(function (name) {
    const documentId = String(name).split("/").pop();
    if (!documentId) return;

    const deleteResponse = UrlFetchApp.fetch(
      packagingCleanupBaseUrl_() + "/packagingOperations/" + encodeURIComponent(documentId),
      {
        method: "delete",
        headers: { Authorization: "Bearer " + token },
        muteHttpExceptions: true
      }
    );
    const deleteCode = deleteResponse.getResponseCode();
    if (deleteCode === 404 || (deleteCode >= 200 && deleteCode < 300)) {
      deleted++;
      return;
    }
    throw new Error(
      "Packaging operation cleanup delete failed for " + documentId +
      ": HTTP " + deleteCode
    );
  });

  props.setProperty(PACKAGING_CLEANUP_DAY_KEY, today);
  if (deleted > 0) {
    console.log("Packaging operation cleanup deleted " + deleted + " records.");
  }

  return { skipped: false, deleted: deleted };
}


// Legacy operationReceipts are no longer written (requestId idempotency replaced
// them). Delete a small page per day until the old collection is empty.
const OPERATION_RECEIPT_CLEANUP_DAY_KEY = "operation_receipts_cleanup_day_v1";
const OPERATION_RECEIPT_CLEANUP_LIMIT = 50;

function cleanupLegacyOperationReceipts_() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), "Asia/Jerusalem", "yyyy-MM-dd");

  if (props.getProperty(OPERATION_RECEIPT_CLEANUP_DAY_KEY) === today) {
    return { skipped: true, deleted: 0 };
  }

  const token = ScriptApp.getOAuthToken();
  const listResponse = UrlFetchApp.fetch(
    packagingCleanupBaseUrl_() + "/operationReceipts?pageSize=" + OPERATION_RECEIPT_CLEANUP_LIMIT,
    {
      method: "get",
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true
    }
  );

  const code = listResponse.getResponseCode();
  if (code === 404) {
    props.setProperty(OPERATION_RECEIPT_CLEANUP_DAY_KEY, today);
    return { skipped: false, deleted: 0 };
  }
  if (code < 200 || code >= 300) {
    throw new Error("Operation receipt cleanup list failed: HTTP " + code);
  }

  const documents = JSON.parse(listResponse.getContentText() || "{}").documents || [];
  let deleted = 0;

  documents.forEach(function (document) {
    const id = String(document.name || "").split("/").pop();
    if (!id) return;
    const response = UrlFetchApp.fetch(
      packagingCleanupBaseUrl_() + "/operationReceipts/" + encodeURIComponent(id),
      {
        method: "delete",
        headers: { Authorization: "Bearer " + token },
        muteHttpExceptions: true
      }
    );
    const deleteCode = response.getResponseCode();
    if (deleteCode === 404 || (deleteCode >= 200 && deleteCode < 300)) {
      deleted++;
      return;
    }
    throw new Error("Operation receipt cleanup delete failed for " + id + ": HTTP " + deleteCode);
  });

  props.setProperty(OPERATION_RECEIPT_CLEANUP_DAY_KEY, today);
  if (deleted > 0) {
    console.log("Legacy operation receipt cleanup deleted " + deleted + " records.");
  }
  return { skipped: false, deleted: deleted };
}
