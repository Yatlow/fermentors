// ================================================================
// DURABLE BREW SHEET CREATION OUTBOX
// ================================================================
// Browser writes a tiny Firestore job and returns immediately. The existing
// five-minute maintenance trigger creates the Drive copy and publishes
// pendingBrews. This keeps slow Drive/SpreadsheetApp work off the UI path.
// ================================================================

const BREW_CREATE_JOB_LIMIT_ = 5;

function brewCreateJobField_(doc, name) {
  return sheetSyncField_(doc, name);
}

function brewCreatePendingJobs_() {
  const response = sheetSyncFetch_(sheetSyncDocumentsUrl_(":runQuery"), {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "brewSheetCreationJobs" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "state" },
            op: "EQUAL",
            value: { stringValue: "queued" }
          }
        },
        limit: BREW_CREATE_JOB_LIMIT_
      }
    })
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Failed loading brew creation jobs: HTTP " + code);
  return (JSON.parse(response.getContentText() || "[]") || [])
    .map(function (row) { return row.document || null; })
    .filter(Boolean);
}

function brewCreatePatchJob_(jobId, fields) {
  const names = Object.keys(fields);
  const mask = names.map(function (name) {
    return "updateMask.fieldPaths=" + encodeURIComponent(name);
  }).join("&");
  const encoded = {};
  names.forEach(function (name) {
    const value = fields[name];
    if (typeof value === "number") encoded[name] = { integerValue: String(value) };
    else if (value === null) encoded[name] = { nullValue: null };
    else encoded[name] = { stringValue: String(value) };
  });
  const response = sheetSyncFetch_(
    sheetSyncDocumentsUrl_("/brewSheetCreationJobs/" + encodeURIComponent(jobId) + "?" + mask),
    { method: "patch", contentType: "application/json", payload: JSON.stringify({ fields: encoded }) }
  );
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Failed updating brew creation job: HTTP " + code);
}

function brewCreatePublishPending_(job, created) {
  const batch = String(job.batchNumber);
  const url = sheetSyncDocumentsUrl_("/pendingBrews/" + encodeURIComponent(batch));
  const response = sheetSyncFetch_(url, {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify({
      fields: {
        batchNumber: { stringValue: batch },
        beerStyle: { stringValue: String(job.style || "") },
        tankNumber: { stringValue: String(job.tankNumber || "") },
        tankType: { stringValue: String(job.tankType || "") },
        fileId: { stringValue: String(created.id || "") },
        fileName: { stringValue: String(created.name || "") },
        sheetUrl: { stringValue: String(created.url || "") },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    })
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Failed publishing pending brew: HTTP " + code);
}

function processPendingBrewSheetCreationJobs_() {
  const documents = brewCreatePendingJobs_();
  const stats = { found: documents.length, ready: 0, failed: 0 };

  documents.forEach(function (document) {
    const jobId = sheetSyncDocumentId_(document);
    const job = {
      batchNumber: String(brewCreateJobField_(document, "batchNumber") || jobId),
      style: String(brewCreateJobField_(document, "style") || ""),
      tankNumber: String(brewCreateJobField_(document, "tankNumber") || ""),
      tankType: String(brewCreateJobField_(document, "tankType") || ""),
      name: String(brewCreateJobField_(document, "name") || ""),
      initialWritesJson: String(brewCreateJobField_(document, "initialWritesJson") || "[]"),
      attempts: Number(brewCreateJobField_(document, "attempts") || 0)
    };

    try {
      brewCreatePatchJob_(jobId, {
        state: "creating",
        attempts: job.attempts + 1,
        updatedAt: new Date().toISOString(),
        lastError: ""
      });
      const initialWrites = JSON.parse(job.initialWritesJson);
      if (!Array.isArray(initialWrites)) throw new Error("Invalid initialWritesJson");
      // Idempotency across worker retries: if a previous attempt created the
      // Drive file but died before publishing Firestore state, adopt that file
      // instead of creating a duplicate batch Sheet.
      const existingCandidate = (getBrewFolderCandidatesCached() || []).find(function (candidate) {
        return String(candidate.batch || brewingSheetBatchFromName_(candidate.fileName)) === job.batchNumber;
      });
      const created = existingCandidate
        ? {
            id: String(existingCandidate.fileId || ""),
            name: String(existingCandidate.fileName || job.name),
            url: buildSheetUrl(existingCandidate.fileId)
          }
        : brewingSheetCreate_({
            batchNumber: job.batchNumber,
            style: job.style,
            tankNumber: job.tankNumber,
            tankType: job.tankType,
            name: job.name,
            initialWrites: initialWrites
          });
      brewCreatePublishPending_(job, created);
      brewCreatePatchJob_(jobId, {
        state: "ready",
        fileId: created.id,
        fileName: created.name,
        sheetUrl: created.url,
        updatedAt: new Date().toISOString(),
        lastError: ""
      });
      stats.ready++;
    } catch (error) {
      try {
        brewCreatePatchJob_(jobId, {
          state: "failed",
          attempts: job.attempts + 1,
          updatedAt: new Date().toISOString(),
          lastError: String(error && error.message || error).slice(0, 1000)
        });
      } catch (markError) {
        console.log("Brew creation job mark failed: " + markError.message);
      }
      stats.failed++;
    }
  });

  if (stats.found) console.log("Brew creation outbox: " + JSON.stringify(stats));
  return stats;
}
