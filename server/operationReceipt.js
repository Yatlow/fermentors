// ============================================================
// OPERATION RECEIPTS
// ============================================================
// Apps Script can finish a mutation successfully while Google's ContentService
// redirect returns HTML to the browser instead of our JSON response. For the
// Sheet-writing actions below we persist the exact successful response in
// Firestore before returning it. The frontend can then confirm the mutation
// directly from Firestore using the same requestId.
// Receipt writer is invoked from doPost only after an idempotent mutation has
// completed successfully, so it is an acknowledgement rather than a guess.
// ============================================================

const OPERATION_RECEIPT_ACTIONS = {
  addFermentationMeasurements: true,
  addFermentationMeasurement: true,
  updatePackagingInfo: true,
  logPackagingToMasterSheet: true,
  assignDryHop: true
};

const OPERATION_RECEIPT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OPERATION_RECEIPT_MAX_RESPONSE_CHARS = 700000;

function shouldWriteOperationReceipt_(action, requestId, response) {
  return Boolean(
    OPERATION_RECEIPT_ACTIONS[String(action || "")] &&
    String(requestId || "").trim() &&
    response &&
    response.success !== false
  );
}

function writeOperationReceipt_(data, response, authenticatedUser) {
  const action = String(data && data.action || "");
  const requestId = String(data && data.requestId || "").trim();

  if (!shouldWriteOperationReceipt_(action, requestId, response)) return false;

  const responseJson = JSON.stringify(response);
  if (responseJson.length > OPERATION_RECEIPT_MAX_RESPONSE_CHARS) {
    logToSheet(
      "Operation receipt skipped: response too large action=" + action +
      " requestId=" + requestId
    );
    return false;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + OPERATION_RECEIPT_TTL_MS);
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/operationReceipts/" +
    encodeURIComponent(requestId);

  const body = {
    fields: {
      requestId: { stringValue: requestId },
      action: { stringValue: action },
      userEmail: { stringValue: String(authenticatedUser && authenticatedUser.email || "") },
      success: { booleanValue: true },
      completedAt: { timestampValue: now.toISOString() },
      expiresAt: { timestampValue: expiresAt.toISOString() },
      responseJson: { stringValue: responseJson }
    }
  };

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const firestoreResponse = UrlFetchApp.fetch(url, {
        method: "patch",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });

      const code = firestoreResponse.getResponseCode();
      if (code >= 200 && code < 300) {
        Logger.log(
          "Operation receipt saved action=" + action +
          " requestId=" + requestId
        );
        return true;
      }

      lastError = new Error(
        "Firestore receipt write failed: " + code + " " +
        firestoreResponse.getContentText().slice(0, 300)
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt === 0) Utilities.sleep(50);
  }

  logToSheet(
    "Operation receipt FAILED action=" + action +
    " requestId=" + requestId +
    " error=" + (lastError && lastError.message ? lastError.message : String(lastError))
  );
  return false;
}
