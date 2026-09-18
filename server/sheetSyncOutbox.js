// ================================================================
// DURABLE SHEET SYNC OUTBOX
// ================================================================
// Fast note-only cellar actions are committed to Firestore first and the UI is
// allowed to close immediately. Each such commit also creates sheetSyncJobs/<id>.
// The browser normally performs the Sheet write at once and deletes the job.
// If Safari closes, connectivity disappears, or Google's ContentService loses
// the response, this worker safely finishes/confirms the operation later using
// the exact same requestId and the existing POST idempotency cache.
//
// Security: jobs never contain a trusted Sheet URL. Before retrying we resolve
// the current fermentor document server-side and require its batch to still
// match the job. The worker then uses that fermentor's sheetUrl.
// ================================================================

const SHEET_SYNC_JOB_LIMIT = 10;
const SHEET_SYNC_MAX_ATTEMPTS = 5;

function sheetSyncProjectId_() {
  if (typeof FIREBASE_PROJECT_ID !== "undefined" && FIREBASE_PROJECT_ID) {
    return FIREBASE_PROJECT_ID;
  }
  return FIREBASE_AUTH_PROJECT_ID;
}

function sheetSyncDocumentsUrl_(suffix) {
  return "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(sheetSyncProjectId_()) +
    "/databases/(default)/documents" +
    String(suffix || "");
}

function sheetSyncFetch_(url, options) {
  const request = Object.assign({}, options || {});
  request.headers = Object.assign({}, request.headers || {}, {
    Authorization: "Bearer " + ScriptApp.getOAuthToken()
  });
  request.muteHttpExceptions = true;
  return UrlFetchApp.fetch(url, request);
}

function sheetSyncSimpleValue_(value) {
  if (!value || typeof value !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return value.booleanValue === true;
  if (Object.prototype.hasOwnProperty.call(value, "timestampValue")) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
  return null;
}

function sheetSyncField_(document, name) {
  return sheetSyncSimpleValue_((document.fields || {})[name]);
}

function sheetSyncDocumentId_(document) {
  const parts = String(document.name || "").split("/");
  return parts[parts.length - 1] || "";
}

function sheetSyncPendingJobs_() {
  const url = sheetSyncDocumentsUrl_(":runQuery");
  const response = sheetSyncFetch_(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "sheetSyncJobs" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "state" },
            op: "EQUAL",
            value: { stringValue: "pending" }
          }
        },
        limit: SHEET_SYNC_JOB_LIMIT
      }
    })
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Failed loading Sheet sync jobs: HTTP " + code);
  }

  const rows = JSON.parse(response.getContentText() || "[]");
  return rows
    .map(function (row) { return row.document || null; })
    .filter(Boolean);
}

function sheetSyncGetFermentor_(tankId) {
  const response = sheetSyncFetch_(
    sheetSyncDocumentsUrl_("/fermentors/" + encodeURIComponent(String(tankId))),
    { method: "get" }
  );
  const code = response.getResponseCode();
  if (code === 404) return null;
  if (code < 200 || code >= 300) {
    throw new Error("Failed loading fermentor " + tankId + ": HTTP " + code);
  }
  return JSON.parse(response.getContentText());
}

function sheetSyncNormalizeBatch_(value) {
  return String(value == null ? "" : value).replace("#", "").trim();
}

function sheetSyncSanitizedReadings_(jobDocument) {
  const raw = String(sheetSyncField_(jobDocument, "readingsJson") || "");
  let readings;
  try {
    readings = JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid readingsJson");
  }

  if (!Array.isArray(readings) || readings.length === 0 || readings.length > 30) {
    throw new Error("Invalid outbox readings list");
  }

  return readings.map(function (reading) {
    const tankId = String(reading && reading.tankId || "").trim();
    const notes = String(reading && reading.notes || "").trim();
    const expectedBatch = sheetSyncNormalizeBatch_(reading && reading.batchNumber);

    if (!tankId || !notes) {
      throw new Error("Outbox reading is missing tankId or notes");
    }

    const fermentor = sheetSyncGetFermentor_(tankId);
    if (!fermentor) throw new Error("Fermentor no longer exists: " + tankId);

    const currentBatch = sheetSyncNormalizeBatch_(sheetSyncField_(fermentor, "batchNumber"));
    if (expectedBatch && currentBatch !== expectedBatch) {
      const mismatch = new Error(
        "Tank " + tankId + " changed batch from " + expectedBatch + " to " + currentBatch
      );
      mismatch.sheetSyncTerminal = true;
      throw mismatch;
    }

    const sheetUrl = String(sheetSyncField_(fermentor, "sheetUrl") || "").trim();
    if (!sheetUrl) {
      const missingSheet = new Error("Tank " + tankId + " has no sheetUrl");
      missingSheet.sheetSyncTerminal = true;
      throw missingSheet;
    }

    return {
      tankId: tankId,
      tankNumber: sheetSyncField_(fermentor, "tankNumber") || reading.tankNumber || tankId,
      batchNumber: currentBatch || expectedBatch || null,
      sheetUrl: sheetUrl,
      notes: notes
    };
  });
}

function sheetSyncPackagingPayload_(jobDocument, requestId) {
  const raw = String(sheetSyncField_(jobDocument, "payloadJson") || "");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid packaging payloadJson");
  }

  const productLabel = String(payload && payload.productLabel || "").trim();
  const quantity = Number(payload && payload.quantity);
  const productionDateStr = String(payload && payload.productionDateStr || "").trim();
  const expiryDateStr = String(payload && payload.expiryDateStr || "").trim();
  const batchNumber = String(payload && payload.batchNumber || "").trim();

  if (!productLabel || !Number.isFinite(quantity) || quantity <= 0 || !productionDateStr) {
    const invalid = new Error("Invalid packaging Sheet outbox payload");
    invalid.sheetSyncTerminal = true;
    throw invalid;
  }

  return {
    action: "logPackagingToMasterSheet",
    requestId: requestId,
    productLabel: productLabel,
    quantity: quantity,
    batchNumber: batchNumber,
    expiryDateStr: expiryDateStr,
    productionDateStr: productionDateStr
  };
}

function sheetSyncResponseSucceeded_(response) {
  if (!response || response.success === false) return false;
  if (!Array.isArray(response.results)) return true;
  return response.results.every(function (result) {
    return result && result.success !== false;
  });
}

function sheetSyncDeleteJob_(jobId) {
  const response = sheetSyncFetch_(
    sheetSyncDocumentsUrl_("/sheetSyncJobs/" + encodeURIComponent(jobId)),
    { method: "delete" }
  );
  const code = response.getResponseCode();
  if (code !== 404 && (code < 200 || code >= 300)) {
    throw new Error("Failed deleting Sheet sync job " + jobId + ": HTTP " + code);
  }
}

function sheetSyncMarkJob_(jobId, state, attempts, errorMessage) {
  const mask = ["state", "attempts", "lastError", "lastAttemptAt"]
    .map(function (field) { return "updateMask.fieldPaths=" + encodeURIComponent(field); })
    .join("&");

  const url = sheetSyncDocumentsUrl_(
    "/sheetSyncJobs/" + encodeURIComponent(jobId) + "?" + mask
  );

  const response = sheetSyncFetch_(url, {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify({
      fields: {
        state: { stringValue: state },
        attempts: { integerValue: String(attempts) },
        lastError: { stringValue: String(errorMessage || "").slice(0, 1000) },
        lastAttemptAt: { timestampValue: new Date().toISOString() }
      }
    })
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Failed updating Sheet sync job " + jobId + ": HTTP " + code);
  }
}

function processPendingSheetSyncJobs_() {
  const jobs = sheetSyncPendingJobs_();
  const stats = { found: jobs.length, completed: 0, failed: 0, deferred: 0 };

  jobs.forEach(function (jobDocument) {
    const jobId = sheetSyncDocumentId_(jobDocument);
    const requestId = String(sheetSyncField_(jobDocument, "requestId") || jobId).trim();
    const attempts = Number(sheetSyncField_(jobDocument, "attempts") || 0);

    if (!jobId || !requestId) {
      stats.failed++;
      return;
    }

    try {
      const action = String(sheetSyncField_(jobDocument, "action") || "").trim();
      if (action !== "addFermentationMeasurements" && action !== "logPackagingToMasterSheet") {
        const unsupported = new Error("Unsupported Sheet sync action: " + action);
        unsupported.sheetSyncTerminal = true;
        throw unsupported;
      }

      const key = postIdempotencyKey_(action, requestId);
      const existing = postReadIdempotencyRecord_(key);

      if (existing && existing.state === "done" && existing.response) {
        if (sheetSyncResponseSucceeded_(existing.response)) {
          sheetSyncDeleteJob_(jobId);
          stats.completed++;
        } else {
          sheetSyncMarkJob_(jobId, "failed", attempts + 1, "Previous Sheet attempt returned a partial failure");
          stats.failed++;
        }
        return;
      }

      if (
        existing &&
        existing.state === "in_progress" &&
        Date.now() - Number(existing.startedAt || 0) <= POST_IDEMPOTENCY_IN_PROGRESS_TTL_MS
      ) {
        stats.deferred++;
        return;
      }

      const payload = action === "addFermentationMeasurements"
        ? {
            action: action,
            requestId: requestId,
            readings: sheetSyncSanitizedReadings_(jobDocument)
          }
        : sheetSyncPackagingPayload_(jobDocument, requestId);

      const result = runPostActionIdempotently_(payload);

      if (!sheetSyncResponseSucceeded_(result)) {
        sheetSyncMarkJob_(jobId, "failed", attempts + 1, "Sheet write returned a partial failure");
        stats.failed++;
        return;
      }

      sheetSyncDeleteJob_(jobId);
      stats.completed++;
    } catch (error) {
      const nextAttempts = attempts + 1;
      const terminal = error && error.sheetSyncTerminal === true;
      const state = terminal || nextAttempts >= SHEET_SYNC_MAX_ATTEMPTS ? "failed" : "pending";

      try {
        sheetSyncMarkJob_(jobId, state, nextAttempts, error && error.message ? error.message : error);
      } catch (markError) {
        console.log("Sheet sync outbox mark failed for " + jobId + ": " + markError.message);
      }

      if (state === "failed") stats.failed++;
      else stats.deferred++;
    }
  });

  if (stats.found > 0) {
    console.log("Sheet sync outbox: " + JSON.stringify(stats));
  }
  return stats;
}
