// ============================================================
// BREW ACTION SERVICE
// ============================================================
//
// ACTION FLOW:
//
// 0 -> Check current sheet only.
//      If brewDate exists and brewDate >= today:
//      ACTION becomes 1.
//
// 1 -> Check Firebase fermentor.tankStatus.
//      If TRUE:
//      ACTION becomes 3.
//
// 3 -> Controlled by GUI.
// 4 -> Controlled by GUI.
//
// 5 -> Search BREW_FOLDER_ID recursively, including
//      all subfolders.
//      Find next valid brew by filename batch number.
//      Check actual tank number using extractBrew().
//      If found:
//        - upload brew to Firebase
//        - replace fermentor.sheetUrl
//        - ACTION becomes 0
//
// ============================================================
//
// PERFORMANCE:
//
// 1. Drive folder is scanned only when the Drive snapshot says
//    that something changed.
//
// 2. The candidate snapshot is stored in ScriptProperties.
//
// 3. No CacheService.
// 4. No cache chunking.
// 5. extractBrew() is memoized per execution.
// 6. All ACTION 5 tanks share the same candidate list.
// ============================================================


// ============================================================
// ACTION 5 SNAPSHOT
// ============================================================




// ============================================================
// MAIN SERVICE
// ============================================================

function brewActionService() {

  Logger.log("========================================");
  Logger.log("START BREW ACTION SERVICE");
  Logger.log("========================================");

  const fermentors = getAllFermentorsFromFirebase();

  Logger.log("Fermentors found: " + fermentors.length);

  const needsCandidates = fermentors.some(function (fermentor) {
    return parseAction(fermentor.action) === 5;
  });

  let candidates = [];

  if (needsCandidates) {

    candidates = getBrewFolderCandidatesCached();

    Logger.log(
      "ACTION 5 candidates prepared ONCE: " +
      candidates.length
    );
  }

  // One extractBrew cache for the entire execution.
  const brewExtractCache = {};

  let action0Processed = 0;
  let action1Processed = 0;
  let action5Processed = 0;

  fermentors.forEach(function (fermentor) {

    const tankNumber = fermentor.tankNumber;
    const action = parseAction(fermentor.action);

    try {

      if (action === 0) {
        action0Processed++;
        processAction0(fermentor);
        return;
      }

      if (action === 1) {
        action1Processed++;
        processAction1(fermentor);
        return;
      }

      if (action === 5) {
        action5Processed++;

        processAction5(
          fermentor,
          candidates,
          brewExtractCache
        );

        return;
      }

      // ACTION 3 / 4 -> GUI controlled.

    } catch (error) {

      Logger.log(
        "ERROR processing tank " +
        tankNumber +
        ": " +
        error.message
      );

      Logger.log(error.stack);
    }
  });

  Logger.log("========================================");
  Logger.log("ACTION 0 processed: " + action0Processed);
  Logger.log("ACTION 1 processed: " + action1Processed);
  Logger.log("ACTION 5 processed: " + action5Processed);
  Logger.log("BREW ACTION SERVICE FINISHED");
  Logger.log("========================================");
}


// ============================================================
// ACTION 0
// ============================================================

function processAction0(fermentor) {

  const tankNumber =
    String(fermentor.tankNumber || "").trim();

  const sheetUrl =
    String(fermentor.sheetUrl || "").trim();

  if (!sheetUrl) return;

  let stageInfo;

  try {

    stageInfo =
      extractBrewStageInfo(sheetUrl, fermentor);

  } catch (error) {

    Logger.log(
      "extractBrewStageInfo failed: " +
      error.message
    );

    return;
  }

  if (!stageInfo || !stageInfo.lastBlock) {
    return;
  }

  try {

    updateFermentorBrewProgress(
      tankNumber,
      stageInfo
    );

  } catch (error) {

    Logger.log(
      "updateFermentorBrewProgress failed: " +
      error.message
    );
  }

  if (
    stageInfo.beerVolume !== null &&
    stageInfo.beerVolume !== undefined
  ) {

    updateFermentorAction(
      tankNumber,
      1
    );

    return;
  }

  if (stageInfo.hasUnstartedHeader) {

    Logger.log(
      "Tank " +
      tankNumber +
      ": another planned brew block hasn't started yet - staying ACTION 0."
    );

    return;
  }

  const outStage =
    stageInfo.lastBlock.stages.find(
      function (s) {
        return s.code === STAGE_CODE_OUT_TO_FERMENTOR;
      }
    );

  if (
    outStage &&
    outStage.startDateTime
  ) {

    const graceMs =
      2 * 60 * 60 * 1000;

    if (
      Date.now() -
      outStage.startDateTime.getTime() >=
      graceMs
    ) {

      updateFermentorAction(
        tankNumber,
        1
      );

      return;
    }
  }
}


// ============================================================
// ACTION 1
// ============================================================

function processAction1(fermentor) {

  const tankNumber =
    String(fermentor.tankNumber || "").trim();

  const tankStatus =
    fermentor.tankStatus;

  const tankStatusIsTrue =
    tankStatus === true ||
    String(tankStatus)
      .trim()
      .toUpperCase() === "TRUE";

  if (tankStatusIsTrue) {

    updateFermentorAction(
      tankNumber,
      3
    );
  }
}


// ============================================================
// ACTION 5
// ============================================================

function processAction5(
  fermentor,
  candidates,
  brewExtractCache
) {

  const tankNumber =
    String(fermentor.tankNumber || "").trim();

  const currentBatch =
    parseBatchNumber(
      fermentor.batchNumber
    );

  if (currentBatch === null) {

    Logger.log(
      "ACTION 5 Tank " +
      tankNumber +
      ": invalid current batch."
    );

    return;
  }

  const nextBrew =
    findNextBrewForTankRecursive(
      tankNumber,
      currentBatch,
      candidates,
      brewExtractCache
    );

  if (!nextBrew) {

    Logger.log(
      "ACTION 5 Tank " +
      tankNumber +
      ": no matching future brew found."
    );

    return;
  }

  uploadBrewToFirebase(
    nextBrew.sheetUrl
  );

  updateFermentorSheetUrl(
    tankNumber,
    nextBrew.sheetUrl
  );

  updateFermentorAction(
    tankNumber,
    0
  );

  Logger.log(
    "ACTION 5 completed successfully for tank " +
    tankNumber +
    " -> batch " +
    nextBrew.batchNumber
  );
}


// ============================================================
// FIND NEXT BREW
// ============================================================

function findNextBrewForTankRecursive(
  tankNumber,
  currentBatch,
  candidates,
  brewExtractCache
) {

  Logger.log(
    "ACTION 5 SEARCH Tank: " +
    tankNumber
  );

  if (!candidates) {
    candidates =
      getBrewFolderCandidatesCached();
  }

  if (!brewExtractCache) {
    brewExtractCache = {};
  }

  const targetTank =
    normalizeTankNumber(
      tankNumber
    );

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    const candidate =
      candidates[i];

    if (
      candidate.batch <= currentBatch
    ) {
      continue;
    }

    let brew;

    try {

      brew =
        extractBrewCached(
          candidate.fileId,
          brewExtractCache
        );

    } catch (error) {

      Logger.log(
        "extractBrew failed for " +
        candidate.fileName +
        ": " +
        error.message
      );

      continue;
    }

    if (!brew) {
      continue;
    }

    const extractedTank =
      normalizeTankNumber(
        brew.tankNumber
      );

    if (
      !tankNumbersEqual(
        extractedTank,
        targetTank
      )
    ) {
      continue;
    }

    return {
      found: true,

      batchNumber:
        String(candidate.batch),

      tankNumber:
        tankNumber,

      beerStyle:
        brew.beerStyle,

      brewDate:
        brew.brewDate,

      beerVolume:
        brew.beerVolume,

      startingPlato:
        brew.startingPlato,

      sheetUrl:
        buildSheetUrl(
          candidate.fileId
        ),

      fileId:
        candidate.fileId,

      fileName:
        candidate.fileName
    };
  }

  return null;
}


// ============================================================
// extractBrew MEMOIZATION
// ============================================================

function extractBrewCached(
  fileId,
  brewExtractCache
) {

  if (
    Object.prototype.hasOwnProperty.call(
      brewExtractCache,
      fileId
    )
  ) {

    return brewExtractCache[fileId];
  }

  const brew =
    extractBrew(fileId);

  brewExtractCache[fileId] =
    brew;

  return brew;
}


// ============================================================
// BREW FOLDER SNAPSHOT
// ============================================================
//
// IMPORTANT:
//
// This function does NOT use CacheService.
//
// It asks Drive Changes API:
//
// "Has anything changed since our last token?"
//
// If NO:
//     return saved snapshot.
//
// If YES:
//     perform ONE full recursive scan
//     and replace snapshot.
//
// ============================================================

function getBrewFolderCandidatesCached() {

  const props =
    PropertiesService.getScriptProperties();

  const snapshotJson =
    props.getProperty(
      BREW_CANDIDATES_SNAPSHOT_KEY
    );

  const changeToken =
    props.getProperty(
      BREW_DRIVE_CHANGE_TOKEN_KEY
    );

  // ----------------------------------------------------------
  // FIRST RUN
  // ----------------------------------------------------------

  if (!snapshotJson || !changeToken) {

    Logger.log(
      "ACTION 5: no Drive snapshot yet - first scan."
    );

    const candidates =
      performFullBrewFolderScan_();

    saveBrewCandidatesSnapshot_(
      candidates
    );

    const newToken =
      getCurrentDriveChangeToken_();

    props.setProperty(
      BREW_DRIVE_CHANGE_TOKEN_KEY,
      newToken
    );

    Logger.log(
      "ACTION 5: initial Drive snapshot saved."
    );

    return candidates;
  }

  // ----------------------------------------------------------
  // EXISTING SNAPSHOT
  // ----------------------------------------------------------

  Logger.log(
    "ACTION 5: checking Drive Changes API..."
  );

  let changesResult;

  try {

    changesResult =
      checkDriveChangesSinceToken_(
        changeToken
      );

  } catch (error) {

    Logger.log(
      "ACTION 5: Drive Changes API failed: " +
      error.message
    );

    // IMPORTANT:
    // Do NOT silently perform a full scan.
    //
    // Otherwise an API configuration problem makes every
    // 5-minute cycle expensive.
    //
    // Keep using the last known snapshot.
    Logger.log(
      "ACTION 5: keeping existing snapshot. " +
      "No full scan performed."
    );

    return JSON.parse(
      snapshotJson
    );
  }

  // ----------------------------------------------------------
  // NO CHANGES
  // ----------------------------------------------------------

  if (!changesResult.hasChanges) {

    Logger.log(
      "ACTION 5: Drive folder unchanged - using snapshot."
    );

    return JSON.parse(
      snapshotJson
    );
  }

  // ----------------------------------------------------------
  // CHANGES DETECTED
  // ----------------------------------------------------------

  Logger.log(
    "ACTION 5: Drive changes detected (" +
    changesResult.changeCount +
    ") - rebuilding snapshot."
  );

  const candidates =
    performFullBrewFolderScan_();

  saveBrewCandidatesSnapshot_(
    candidates
  );

  props.setProperty(
    BREW_DRIVE_CHANGE_TOKEN_KEY,
    changesResult.newStartPageToken
  );

  Logger.log(
    "ACTION 5: snapshot updated. Candidates: " +
    candidates.length
  );

  return candidates;
}


// ============================================================
// FULL SCAN
// ============================================================

function performFullBrewFolderScan_() {

  const started =
    new Date().getTime();

  Logger.log(
    "ACTION 5: STARTING FULL BREW FOLDER SCAN"
  );

  const candidates =
    scanBrewFolderCandidates();

  const duration =
    (
      new Date().getTime() -
      started
    ) / 1000;

  Logger.log(
    "ACTION 5: FULL BREW FOLDER SCAN FINISHED in " +
    duration +
    "s"
  );

  return candidates;
}


// ============================================================
// SAVE SNAPSHOT
// ============================================================

function saveBrewCandidatesSnapshot_(
  candidates
) {

  const props =
    PropertiesService.getScriptProperties();

  props.setProperty(
    BREW_CANDIDATES_SNAPSHOT_KEY,
    JSON.stringify(candidates)
  );

  Logger.log(
    "ACTION 5: saved " +
    candidates.length +
    " candidates to snapshot."
  );
}


// ============================================================
// DRIVE CHANGES API
// ============================================================
//
// Drive API v3:
//
// Drive.Changes.list(pageToken)
//
// Valid partial response:
//
// nextPageToken,
// newStartPageToken,
// changes(fileId,removed)
//
// The file ID belongs to the change resource as `fileId`.
// We intentionally do NOT request `changes(id)`.
//
// ============================================================

function checkDriveChangesSinceToken_(
  pageToken
) {

  let token =
    pageToken;

  let changeCount = 0;

  while (token) {

    const response =
      Drive.Changes.list(token, {

        pageSize: 1000,

        includeItemsFromAllDrives: true,

        supportsAllDrives: true,

        includeRemoved: true,

        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed)"
      });

    const changes =
      response.changes || [];

    changeCount +=
      changes.length;

    if (
      response.newStartPageToken
    ) {

      return {
        hasChanges:
          changeCount > 0,

        changeCount:
          changeCount,

        newStartPageToken:
          response.newStartPageToken
      };
    }

    token =
      response.nextPageToken;
  }

  throw new Error(
    "Drive Changes API returned no newStartPageToken."
  );
}


// ============================================================
// GET CURRENT DRIVE CHANGE TOKEN
// ============================================================

function getCurrentDriveChangeToken_() {

  const response =
    Drive.Changes.getStartPageToken({

      supportsAllDrives: true

    });

  if (
    !response ||
    !response.startPageToken
  ) {

    throw new Error(
      "Could not get Drive startPageToken."
    );
  }

  return response.startPageToken;
}


// ============================================================
// FULL DRIVE SCAN
// ============================================================

function scanBrewFolderCandidates() {

  const rootFolder =
    DriveApp.getFolderById(
      BREW_FOLDER_ID
    );

  const files = [];

  collectGoogleSheetsRecursive(
    rootFolder,
    files
  );

  Logger.log(
    "Total Google Sheets found recursively: " +
    files.length
  );

  const candidates = [];

  files.forEach(function (file) {

    const fileName =
      file.getName();

    const batch =
      extractBatchFromFilename(
        fileName
      );

    if (batch === null) {
      return;
    }

    candidates.push({

      fileId:
        file.getId(),

      fileName:
        fileName,

      batch:
        batch
    });
  });

  candidates.sort(
    function (a, b) {
      return a.batch - b.batch;
    }
  );

  Logger.log(
    "Candidates with valid batch numbers: " +
    candidates.length
  );

  return candidates;
}


// ============================================================
// FORCE SNAPSHOT RESET
// ============================================================

function resetBrewDriveSnapshot() {

  const props =
    PropertiesService.getScriptProperties();

  props.deleteProperty(
    BREW_CANDIDATES_SNAPSHOT_KEY
  );

  props.deleteProperty(
    BREW_DRIVE_CHANGE_TOKEN_KEY
  );

  Logger.log(
    "ACTION 5: Drive snapshot reset."
  );
}


// ============================================================
// BUILD SHEET URL
// ============================================================

function buildSheetUrl(fileId) {

  return (
    "https://docs.google.com/spreadsheets/d/" +
    fileId +
    "/edit"
  );
}


// ============================================================
// RECURSIVE DRIVE SCAN
// ============================================================

function collectGoogleSheetsRecursive(
  folder,
  result
) {

  const files =
    folder.getFiles();

  while (files.hasNext()) {

    const file =
      files.next();

    if (
      file.getMimeType() ===
      MimeType.GOOGLE_SHEETS
    ) {

      result.push(file);
    }
  }

  const folders =
    folder.getFolders();

  while (folders.hasNext()) {

    collectGoogleSheetsRecursive(
      folders.next(),
      result
    );
  }
}


// ============================================================
// EXTRACT BATCH FROM FILENAME
// ============================================================

function extractBatchFromFilename(
  fileName
) {

  if (!fileName) {
    return null;
  }

  const text =
    String(fileName).trim();

  let match =
    text.match(
      /(\d{4,})\s*#/
    );

  if (match) {

    const batch =
      Number(match[1]);

    if (
      Number.isFinite(batch)
    ) {

      return batch;
    }
  }

  match =
    text.match(
      /#\s*(\d{4,})/
    );

  if (match) {

    const batch =
      Number(match[1]);

    if (
      Number.isFinite(batch)
    ) {

      return batch;
    }
  }

  return null;
}


// ============================================================
// NORMALIZE TANK
// ============================================================

function normalizeTankNumber(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";
  }

  return String(value)
    .trim()
    .replace(
      /^מיכל\s*/i,
      ""
    )
    .trim();
}


// ============================================================
// COMPARE TANK NUMBERS
// ============================================================

function tankNumbersEqual(
  a,
  b
) {

  const left =
    normalizeTankNumber(a);

  const right =
    normalizeTankNumber(b);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftNumber =
    Number(left);

  const rightNumber =
    Number(right);

  if (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber)
  ) {

    return (
      leftNumber === rightNumber
    );
  }

  return false;
}


// ============================================================
// PARSE ACTION
// ============================================================

function parseAction(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {

    return null;
  }

  return number;
}


// ============================================================
// FIRESTORE: FERMENTORS
// ============================================================

function getAllFermentorsFromFirebase() {

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors";

  const response =
    UrlFetchApp.fetch(url, {

      method: "get",

      headers: {
        Authorization:
          "Bearer " +
          ScriptApp.getOAuthToken()
      },

      muteHttpExceptions: true

    });

  const code =
    response.getResponseCode();

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to get fermentors: " +
      code +
      " " +
      response.getContentText()
    );
  }

  const data =
    JSON.parse(
      response.getContentText()
    );

  const documents =
    data.documents || [];

  return documents.map(
    function (document) {

      const result = {};

      const fields =
        document.fields || {};

      for (
        const key in fields
      ) {

        result[key] =
          normalizeFirestoreValue(
            fields[key]
          );
      }

      if (!result.uid) {

        const parts =
          String(
            document.name || ""
          ).split("/");

        result.uid =
          parts[
            parts.length - 1
          ] || null;
      }

      return result;
    }
  );
}


// ============================================================
// FIRESTORE: SINGLE FERMENTOR
// ============================================================

function getFermentorFromFirebase(
  tankNumber
) {

  const fermentorId =
    String(tankNumber).trim();

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    );

  const document =
    getFirestoreDocument(url);

  if (
    !document ||
    !document.fields
  ) {

    return null;
  }

  const result = {};

  for (
    const key in document.fields
  ) {

    result[key] =
      normalizeFirestoreValue(
        document.fields[key]
      );
  }

  return result;
}


// ============================================================
// UPDATE ACTION
// ============================================================

function updateFermentorAction(
  tankNumber,
  action
) {

  const fermentorId =
    String(tankNumber).trim();

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    ) +
    "?updateMask.fieldPaths=action";

  const document = {
    fields: {
      action:
        toFirestoreValue(action)
    }
  };

  const response =
    UrlFetchApp.fetch(url, {

      method: "patch",

      contentType:
        "application/json",

      headers: {
        Authorization:
          "Bearer " +
          ScriptApp.getOAuthToken()
      },

      payload:
        JSON.stringify(document),

      muteHttpExceptions:
        true

    });

  const code =
    response.getResponseCode();

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to update ACTION for tank " +
      fermentorId +
      ": " +
      code +
      " " +
      response.getContentText()
    );
  }

  Logger.log(
    "Updated tank " +
    fermentorId +
    " ACTION -> " +
    action
  );
}


// ============================================================
// UPDATE SHEET URL
// ============================================================

function updateFermentorSheetUrl(
  tankNumber,
  sheetUrl
) {

  const fermentorId =
    String(tankNumber).trim();

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    ) +
    "?updateMask.fieldPaths=sheetUrl";

  const document = {
    fields: {
      sheetUrl:
        toFirestoreValue(sheetUrl)
    }
  };

  const response =
    UrlFetchApp.fetch(url, {

      method: "patch",

      contentType:
        "application/json",

      headers: {
        Authorization:
          "Bearer " +
          ScriptApp.getOAuthToken()
      },

      payload:
        JSON.stringify(document),

      muteHttpExceptions:
        true

    });

  const code =
    response.getResponseCode();

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to update sheetUrl for tank " +
      fermentorId +
      ": " +
      code +
      " " +
      response.getContentText()
    );
  }
}


// ============================================================
// TESTS
// ============================================================

function testBrewAction0() {

  const tankNumber = "19";

  const fermentor =
    getFermentorFromFirebase(
      tankNumber
    );

  if (!fermentor) {

    throw new Error(
      "Fermentor not found: " +
      tankNumber
    );
  }

  processAction0(
    fermentor
  );
}


function testBrewAction5() {

  const tankNumber = "13";

  const currentBatch = 1566;

  const candidates =
    getBrewFolderCandidatesCached();

  const brewExtractCache = {};

  const result =
    findNextBrewForTankRecursive(
      tankNumber,
      currentBatch,
      candidates,
      brewExtractCache
    );

  Logger.log(
    "TEST ACTION 5 RESULT:"
  );

  Logger.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );

  return result;
}
