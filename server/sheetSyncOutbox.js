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
    const hasValue = function (value) {
      return value !== undefined && value !== null && value !== "";
    };
    const hasMeasurement = ["temp", "pressure", "plato", "pH", "carbonation"]
      .some(function (field) { return hasValue(reading && reading[field]); });

    if (!tankId || (!notes && !hasMeasurement)) {
      throw new Error("Outbox reading is missing tankId or measurement data");
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
      temp: reading.temp,
      pressure: reading.pressure,
      plato: reading.plato,
      pH: reading.pH,
      carbonation: reading.carbonation,
      isEmpty: reading.isEmpty,
      kegs: reading.kegs,
      crates: reading.crates,
      totalLiters: reading.totalLiters,
      shrinkagePercent: reading.shrinkagePercent,
      boldNotes: reading.boldNotes,
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

// Reconcile the exact confirmed Sheet rows into Firestore before deleting the
// durable job. This also covers a lost browser response and a closed Safari tab.
function sheetSyncReconcileMeasurements_(jobDocument, response) {
  const action = String(sheetSyncField_(jobDocument, "action") || "");
  if (action !== "addFermentationMeasurements") return;
  const readings = JSON.parse(String(sheetSyncField_(jobDocument, "readingsJson") || "[]"));
  const results = response && response.results;
  const requestId = String(sheetSyncField_(jobDocument, "requestId") || sheetSyncDocumentId_(jobDocument));
  if (!Array.isArray(results) || results.length !== readings.length) {
    throw new Error("Cannot reconcile Sheet results: incomplete response");
  }
  const writes = [];
  results.forEach(function (entry) {
    const original = readings.find(function (reading) {
      return String(reading.tankId) === String(entry && entry.tankId);
    });
    const result = entry && entry.result;
    if (!original || !entry.success || !result) {
      throw new Error("Cannot reconcile Sheet results: missing confirmed tank row");
    }
    // Avoid overwriting newer optimistic reports with an older complete row.
    // Verify the fermentor's Firestore updateTime in the same atomic commit;
    // any racing submission makes the commit retry on the next outbox cycle.
    const tank = sheetSyncGetFermentor_(original.tankId);
    if (!tank) throw new Error("Cannot reconcile Sheet result: missing tank " + original.tankId);
    const liveBatch = sheetSyncNormalizeBatch_(sheetSyncField_(tank, "batchNumber"));
    if (liveBatch && liveBatch !== sheetSyncNormalizeBatch_(original.batchNumber)) {
      const changed = new Error("Tank batch changed before Sheet history reconciliation");
      changed.sheetSyncTerminal = true;
      throw changed;
    }
    const latestId = String(sheetSyncField_(tank, "latestSheetSyncRequestId") || "");
    if (latestId && latestId !== requestId) return;
    if (!tank.name || !tank.updateTime) {
      throw new Error("Cannot verify tank version for Sheet history reconciliation");
    }
    writes.push({ verify: tank.name, currentDocument: { updateTime: tank.updateTime } });
    const date = String(result.date || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const time = String(result.time || "").match(/^(\d{1,2}):(\d{2})$/);
    const batch = sheetSyncNormalizeBatch_(original.batchNumber);
    if (!date || !time || !batch || !/^\d+$/.test(batch)) {
      throw new Error("Cannot reconcile Sheet results: invalid date, time or batch");
    }
    // Exact same day key as the browser and Sheets reconciliation writer.
    const id = date[3] + "-" + date[2].padStart(2, "0") + "-" +
      date[1].padStart(2, "0");
    const numberValue = function (value) {
      if (value === null || value === undefined || String(value).trim() === "") return { nullValue: null };
      const normalized = String(value).replace(",", ".").replace(/[^0-9.+-]/g, "");
      const n = Number(normalized);
      return Number.isFinite(n) ? { doubleValue: n } : { nullValue: null };
    };
    const fields = {
      date: { stringValue: String(result.date) },
      time: { stringValue: String(result.time) },
      temp: numberValue(result.temperature),
      plato: numberValue(result.sugar),
      pressure: numberValue(result.pressure),
      pH: numberValue(result.pH),
      carbonation: numberValue(result.carbonation),
      notes: { stringValue: String(result.notes || "").trim() }
    };
    const name = "projects/" + sheetSyncProjectId_() +
      "/databases/(default)/documents/brews/" + batch + "/measurements/" + id;
    writes.push({ update: { name: name, fields: fields }, updateMask: {
      fieldPaths: Object.keys(fields)
    } });
  });
  if (!writes.length) return; // Superseded requests are already represented by a newer report.
  // Firestore commits all rows atomically. A failed response keeps the job
  // pending, so maintenance can retry without duplicating Sheet writes.
  const responseCommit = sheetSyncFetch_(sheetSyncDocumentsUrl_(":commit"), {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ writes: writes })
  });
  if (responseCommit.getResponseCode() < 200 || responseCommit.getResponseCode() >= 300) {
    throw new Error("Firestore history reconciliation failed: HTTP " + responseCommit.getResponseCode() +
      " " + responseCommit.getContentText().slice(0, 400));
  }
}

/**
 * A batch may have written some tanks successfully before another failed.
 * Repeating the original batch would duplicate successful cellar notes.
 * Recover ONLY the unsuccessful tanks, with a stable per-tank idempotency key.
 * Persist the combined response under the original requestId before trying
 * Firestore reconciliation, so losing that later response remains safe.
 */
function sheetSyncRecoverPartial_(jobDocument, response, action, requestId) {
  if (action !== "addFermentationMeasurements" ||
      !response || !Array.isArray(response.results)) {
    const unsafe = new Error("Cannot safely retry an ambiguous partial Sheet write");
    unsafe.sheetSyncTerminal = true;
    throw unsafe;
  }
  const original = sheetSyncSanitizedReadings_(jobDocument);
  const results = response.results;
  if (results.length !== original.length) {
    const ambiguous = new Error("Partial Sheet write has mismatched tank count");
    ambiguous.sheetSyncTerminal = true;
    throw ambiguous;
  }
  const merged = results.slice();
  original.forEach(function (reading, index) {
    const old = merged[index];
    if (!old || String(old.tankId) !== String(reading.tankId)) {
      const mismatch = new Error("Cannot safely match partial Sheet results to tanks");
      mismatch.sheetSyncTerminal = true;
      throw mismatch;
    }
    if (old.success === true && old.result) return;
    if (old.success === true && !old.result) {
      const unconfirmed = new Error("Sheet success without row payload: manual reconciliation required");
      unconfirmed.sheetSyncTerminal = true;
      throw unconfirmed;
    }
    const recoveryId = requestId + "-recover-" + String(reading.tankId);
    const recovered = runPostActionIdempotently_({
      action: action,
      requestId: recoveryId,
      readings: [reading]
    });
    const single = recovered && recovered.results && recovered.results[0];
    if (!sheetSyncResponseSucceeded_(recovered) || !single ||
        String(single.tankId) !== String(reading.tankId) || !single.result) {
      const unresolved = new Error("Recovery Sheet write was not confirmed for tank " + reading.tankId);
      unresolved.sheetSyncTerminal = true;
      throw unresolved;
    }
    merged[index] = single;
  });
  const combined = { success: true, action: action, requestId: requestId, results: merged };
  postSaveIdempotencyResult_(postIdempotencyKey_(action, requestId), action, requestId, combined);
  return combined;
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
        const confirmed = sheetSyncResponseSucceeded_(existing.response)
          ? existing.response
          : sheetSyncRecoverPartial_(jobDocument, existing.response, action, requestId);
        sheetSyncReconcileMeasurements_(jobDocument, confirmed);
        sheetSyncDeleteJob_(jobId);
        stats.completed++;
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
        // The original requestId now contains the authoritative partial
        // result. The next worker cycle retries ONLY its failed tank(s).
        const nextAttempts = attempts + 1;
        const state = nextAttempts >= SHEET_SYNC_MAX_ATTEMPTS ? "failed" : "pending";
        sheetSyncMarkJob_(jobId, state, nextAttempts, "Sheet write returned a partial failure");
        if (state === "failed") stats.failed++;
        else stats.deferred++;
        return;
      }

      sheetSyncReconcileMeasurements_(jobDocument, result);
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
