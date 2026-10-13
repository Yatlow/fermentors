// ================================================================
// DURABLE BREW SHEET CREATION OUTBOX
// ================================================================
// Browser writes a tiny Firestore job and returns immediately. The existing
// five-minute maintenance trigger creates the Drive copy and publishes
// pendingBrews. This keeps slow Drive/SpreadsheetApp work off the UI path.
// ================================================================

const BREW_CREATE_JOB_LIMIT_ = 5;
const BREW_CREATE_CREATING_STALE_MS_ = 10 * 60 * 1000;

function brewCreateJobField_(doc, name) {
  return sheetSyncField_(doc, name);
}

function brewCreateIsRunnableDocument_(document) {
  const state = String(brewCreateJobField_(document, "state") || "");
  if (state === "queued") return true;
  if (state !== "creating") return false;

  const updatedAt = Date.parse(String(brewCreateJobField_(document, "updatedAt") || ""));
  return !Number.isFinite(updatedAt) ||
    Date.now() - updatedAt >= BREW_CREATE_CREATING_STALE_MS_;
}

function brewCreatePendingJobs_(requestedJobId) {
  // A direct request should fetch its own document regardless of whether a
  // concurrent worker already moved it from queued -> creating. This makes the
  // immediate path able to resume/publish an interrupted creation.
  if (requestedJobId) {
    const response = sheetSyncFetch_(
      sheetSyncDocumentsUrl_("/brewSheetCreationJobs/" + encodeURIComponent(String(requestedJobId))),
      { method: "get" }
    );
    const code = response.getResponseCode();
    if (code === 404) return [];
    if (code < 200 || code >= 300) throw new Error("Failed loading brew creation job: HTTP " + code);
    const document = JSON.parse(response.getContentText() || "{}");
    return brewCreateIsRunnableDocument_(document) ? [document] : [];
  }

  const response = sheetSyncFetch_(sheetSyncDocumentsUrl_(":runQuery"), {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "brewSheetCreationJobs" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "state" },
            op: "IN",
            value: {
              arrayValue: {
                values: [
                  { stringValue: "queued" },
                  { stringValue: "creating" }
                ]
              }
            }
          }
        },
      }
    })
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Failed loading brew creation jobs: HTTP " + code);
  // Keep this query index-free. Combining state == queued with orderBy(createdAt,
  // __name__) requires a Firestore composite index and caused maintenance HTTP
  // 400 in production. Queue volume is tiny, so sort the returned jobs here.
  return (JSON.parse(response.getContentText() || "[]") || [])
    .map(function (row) { return row.document || null; })
    .filter(Boolean)
    .filter(brewCreateIsRunnableDocument_)
    .sort(function (a, b) {
      const aCreated = String(brewCreateJobField_(a, "createdAt") || "");
      const bCreated = String(brewCreateJobField_(b, "createdAt") || "");
      if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
      const aId = sheetSyncDocumentId_(a);
      const bId = sheetSyncDocumentId_(b);
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    })
    .slice(0, BREW_CREATE_JOB_LIMIT_);
}

function brewCreatePatchJob_(jobId, fields, expectedUpdateTime) {
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
  const precondition = expectedUpdateTime
    ? "&currentDocument.updateTime=" + encodeURIComponent(String(expectedUpdateTime))
    : "";
  const response = sheetSyncFetch_(
    sheetSyncDocumentsUrl_("/brewSheetCreationJobs/" + encodeURIComponent(jobId) + "?" + mask + precondition),
    { method: "patch", contentType: "application/json", payload: JSON.stringify({ fields: encoded }) }
  );
  const code = response.getResponseCode();
  const body = String(response.getContentText() || "");
  if (
    expectedUpdateTime &&
    (
      code === 409 ||
      code === 412 ||
      (code === 400 && /FAILED_PRECONDITION|precondition/i.test(body))
    )
  ) {
    return false;
  }
  if (code < 200 || code >= 300) {
    throw new Error("Failed updating brew creation job: HTTP " + code + (body ? " " + body.slice(0, 300) : ""));
  }
  return true;
}


/**
 * Snapshot the semantic row positions after the actual template has been
 * created and all extra-rest rows inserted. This map contains addresses only,
 * never user measurements. Reopening the form must not need a full Sheet read.
 */
function brewCreateSheetRowMap_(fileId, tankType) {
  const sheet = SpreadsheetApp.openById(fileId).getSheets()[0];
  const rows = sheet.getDataRange().getDisplayValues();
  const expected = String(tankType) === "single" ? 1 : String(tankType) === "double" ? 2 : 3;
  const headers = [];
  for (let index = 0; index < rows.length; index++) {
    if (String(rows[index][1] || "").trim() === "סוג:" &&
        String(rows[index][3] || "").trim() === "אצווה:") headers.push(index);
  }
  if (headers.length < expected) throw new Error("Cannot discover all brew block headers");
  const result = {};
  const fermentationIndex = rows.findIndex(function (row) {
    return /^יום בישול/i.test(String(row[0] || "").trim()) &&
      /שעת הוספת שמרים/i.test(String(row[4] || "").trim());
  });
  const stages = [
    ["mashIn", /^הכנסת לתת$/i], ["rest1", /^השריה\s*1$/i],
    ["heat1", /^חימום\s*1$/i], ["rest2", /^השריה\s*2$/i],
    ["heat2", /^חימום\s*2$/i], ["rest3", /^השריה\s*3$/i],
    ["heat3", /^חימום\s*3$/i], ["transferLt", /^העברה\s+ל.*L\.?T\.?/i],
    ["restLt", /^מנוחה\s*L\.?T\.?/i], ["circulation", /^סחרור/i],
    ["outToBoil", /^הוצאה לבישול$/i], ["endTransfer", /^סוף העברה$/i],
    ["boil", /^(?:תחילת\s+)?רתיחה(?:\s+100°?C)?$/i],
    ["hop1", /^הוספת כ(?:שות|שת)\s*1$/i],
    ["hop2", /^הוספת כ(?:שות|שת)\s*2$/i],
    ["hop3", /^הוספת כ(?:שות|שת)\s*3$/i],
    ["hop4", /^הוספת כ(?:שות|שת)\s*4$/i],
    ["wp", /סוף רתיחה.*תחילת\s*WP/i], ["outToFermentor", /^הוצאה לתסיסה$/i]
  ];
  const sugars = [
    ["frPlato", /^F\.R\.?\s*$/i], ["lrPlato", /^L\.R\.?\s*$/i],
    ["kettlePlato", /^סיר בישול/i], ["endBoilPlato", /^סוף רתיחה$/i],
    ["fermentorSamplePlato", /^תחילת תסיסה$/i]
  ];
  for (let block = 0; block < expected; block++) {
    const first = headers[block];
    const last = headers[block + 1] || rows.length;
    const fields = { "__sheetRow.header": String(first + 1) };
    if (fermentationIndex >= 0) fields["__sheetRow.fermentation"] = String(fermentationIndex + 1);
    const acid = [];
    let rawHopHeader = -1;
    for (let i = first; i < last; i++) {
      const row = rows[i] || [];
      const label = String(row[3] || "").trim();
      const sugarLabel = String(row[0] || "").trim();
      if (/^HLT$/i.test(sugarLabel)) fields["__sheetRow.water.hlt"] = String(i + 1);
      if (/^MASH\s*IN$/i.test(sugarLabel)) fields["__sheetRow.water.mashIn"] = String(i + 1);
      for (let j = 0; j < stages.length; j++) {
        if (stages[j][1].test(label)) fields["__sheetRow.stage." + stages[j][0]] = String(i + 1);
      }
      const rinse = /^שטיפה\s*([1-7])$/i.exec(label);
      if (rinse) fields["__sheetRow.rinse." + rinse[1]] = String(i + 1);
      for (let j = 0; j < sugars.length; j++) {
        if (sugars[j][1].test(sugarLabel)) fields["__sheetRow.sugar." + sugars[j][0]] = String(i + 1);
      }
      if (/H3PO4/i.test(String(row[2] || ""))) acid.push(i + 1);
      if (/^כמות$/i.test(sugarLabel) && /אחוז.*אלפ/i.test(String(row[1] || "")) &&
          /סוג/i.test(String(row[2] || ""))) rawHopHeader = i;
      if (/^שמרים$/i.test(String(row[2] || "").trim())) fields["__sheetRow.material.yeast"] = String(i + 1);
    }
    if (acid[0]) fields["__sheetRow.acid.mash"] = String(acid[0]);
    if (acid[1]) fields["__sheetRow.acid.boil"] = String(acid[1]);
    if (rawHopHeader >= 0) {
      for (let j = 1; j <= 5; j++) fields["__sheetRow.rawHop." + j] = String(rawHopHeader + j + 1);
    }
    if (fields["__sheetRow.sugar.kettlePlato"]) fields["__sheetRow.sugar.kettleVolume"] = fields["__sheetRow.sugar.kettlePlato"];
    if (fields["__sheetRow.sugar.endBoilPlato"]) fields["__sheetRow.sugar.endBoilVolume"] = fields["__sheetRow.sugar.endBoilPlato"];
    if (fields["__sheetRow.sugar.fermentorSamplePlato"]) fields["__sheetRow.sugar.cumulativeTankVolume"] = fields["__sheetRow.sugar.fermentorSamplePlato"];
    if (!fields["__sheetRow.stage.mashIn"] || !fields["__sheetRow.stage.outToBoil"]) {
      throw new Error("Incomplete semantic row map for brew block " + (block + 1));
    }
    result[String(block + 1)] = fields;
  }
  return result;
}

function brewCreatePublishRowMap_(job, fileId) {
  const map = brewCreateSheetRowMap_(fileId, job.tankType);
  const batch = String(job.batchNumber);
  const response = sheetSyncFetch_(
    sheetSyncDocumentsUrl_("/brews/" + encodeURIComponent(batch) + "?updateMask.fieldPaths=brewSheetRowMapJson"),
    {
      method: "patch",
      contentType: "application/json",
      payload: JSON.stringify({ fields: {
        brewSheetRowMapJson: { stringValue: JSON.stringify({ version: 1, spreadsheetId: fileId, blocks: map }) }
      } })
    }
  );
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Failed publishing brew row map: HTTP " + response.getResponseCode());
  }
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
        ...(typeof job.dryHopRequired === "boolean" ? { dryHopRequired: { booleanValue: job.dryHopRequired } } : {}),
        ...(job.dryHopTargetPlato !== null && Number.isFinite(job.dryHopTargetPlato) ? { dryHopTargetPlato: { doubleValue: job.dryHopTargetPlato } } : {}),
        createdAt: { timestampValue: new Date().toISOString() }
      }
    })
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Failed publishing pending brew: HTTP " + code);
}

function processPendingBrewSheetCreationJobs_(requestedJobId) {
  let documents = brewCreatePendingJobs_(requestedJobId);
  const stats = { found: documents.length, ready: 0, failed: 0 };
  if (!documents.length) return stats;

  documents.forEach(function (document) {
    const jobId = sheetSyncDocumentId_(document);
    const job = {
      batchNumber: String(brewCreateJobField_(document, "batchNumber") || jobId),
      style: String(brewCreateJobField_(document, "style") || ""),
      tankNumber: String(brewCreateJobField_(document, "tankNumber") || ""),
      tankType: String(brewCreateJobField_(document, "tankType") || ""),
      name: String(brewCreateJobField_(document, "name") || ""),
      initialWritesJson: String(brewCreateJobField_(document, "initialWritesJson") || "[]"),
      recipeMaterialsJson: String(brewCreateJobField_(document, "recipeMaterialsJson") || "{}"),
      dryHopRequired: (function (value) { return typeof value === "boolean" ? value : null; })(brewCreateJobField_(document, "dryHopRequired")),
      dryHopTargetPlato: (function (value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null; })(brewCreateJobField_(document, "dryHopTargetPlato")),
      mashRestCount: Number(brewCreateJobField_(document, "mashRestCount") || 2),
      attempts: Number(brewCreateJobField_(document, "attempts") || 0),
      fileId: String(brewCreateJobField_(document, "fileId") || ""),
      fileName: String(brewCreateJobField_(document, "fileName") || ""),
      sheetUrl: String(brewCreateJobField_(document, "sheetUrl") || "")
    };

    try {
      const claimed = brewCreatePatchJob_(jobId, {
        state: "creating",
        attempts: job.attempts + 1,
        updatedAt: new Date().toISOString(),
        lastError: ""
      }, document.updateTime || "");
      if (!claimed) return;

      const initialWrites = JSON.parse(job.initialWritesJson);
      if (!Array.isArray(initialWrites)) throw new Error("Invalid initialWritesJson");
      const recipeMaterials = JSON.parse(job.recipeMaterialsJson || "{}");
      if (!recipeMaterials || typeof recipeMaterials !== "object" || Array.isArray(recipeMaterials)) {
        throw new Error("Invalid recipeMaterialsJson");
      }

      let created;
      if (job.fileId) {
        // Retry an interrupted job directly from its durable fileId. Never scan
        // the brewing Drive folder to rediscover work already owned by outbox.
        const file = DriveApp.getFileById(job.fileId);
        created = {
          id: job.fileId,
          name: job.fileName || file.getName(),
          url: job.sheetUrl || file.getUrl()
        };
      } else {
        created = brewingSheetCreate_({
          batchNumber: job.batchNumber,
          style: job.style,
          tankNumber: job.tankNumber,
          tankType: job.tankType,
          name: job.name,
          initialWrites: initialWrites,
          recipeMaterials: recipeMaterials,
          mashRestCount: job.mashRestCount
        });

        // Persist identity before publishing pendingBrews. Any later retry can
        // resume by ID and therefore does not need a Drive folder scan.
        brewCreatePatchJob_(jobId, {
          state: "creating",
          fileId: created.id,
          fileName: created.name,
          sheetUrl: created.url,
          updatedAt: new Date().toISOString(),
          lastError: ""
        });
      }

      // Row-map persistence is best-effort during job creation. An unusual
      // legacy template must not prevent a successfully created Sheet from
      // being published; the form can discover the map once on first open.
      try {
        brewCreatePublishRowMap_(job, created.id);
      } catch (mapError) {
        console.warn("Failed precomputing brew Sheet row map for " + job.batchNumber + ": " + mapError);
      }
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
        // Keep the job retryable. A Drive/Spreadsheet transient must not strand
        // the batch forever in failed/creating; maintenance will pick it up.
        brewCreatePatchJob_(jobId, {
          state: "queued",
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

  console.log("Brew creation outbox: " + JSON.stringify(stats));
  return stats;
}

function processBrewSheetCreationJobNow_(jobId) {
  // Do not hold the global ScriptLock while copying/initialising a Sheet.
  // The Firestore updateTime precondition above is the per-job claim: only one
  // worker can move a particular job into its current creating attempt.
  return processPendingBrewSheetCreationJobs_(String(jobId || ""));
}
