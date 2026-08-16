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


// ============================================================
// MAIN SERVICE
// ============================================================

function brewActionService() {

  Logger.log("========================================");
  Logger.log("START BREW ACTION SERVICE");
  Logger.log("========================================");


  // ----------------------------------------------------------
  // GET ALL FERMENTORS
  // ----------------------------------------------------------

  const fermentors =
    getAllFermentorsFromFirebase();


  Logger.log(
    "Fermentors found: " +
    fermentors.length
  );


  let action0Processed = 0;
  let action1Processed = 0;
  let action5Processed = 0;


  // ----------------------------------------------------------
  // PROCESS EACH FERMENTOR
  // ----------------------------------------------------------

  fermentors.forEach(
    function(fermentor) {

      const tankNumber =
        fermentor.tankNumber;

      const action =
        parseAction(
          fermentor.action
        );


      Logger.log("----------------------------------------");

      Logger.log(
        "Tank: " +
        tankNumber +
        " | ACTION: " +
        action
      );


      try {

        // ======================================================
        // ACTION 0
        // ======================================================

        if (action === 0) {

          action0Processed++;

          processAction0(
            fermentor
          );

          return;
        }


        // ======================================================
        // ACTION 1
        // ======================================================

        if (action === 1) {

          action1Processed++;

          processAction1(
            fermentor
          );

          return;
        }


        // ======================================================
        // ACTION 3
        // ======================================================

        if (action === 3) {

          Logger.log(
            "ACTION 3 - waiting for GUI."
          );

          return;
        }


        // ======================================================
        // ACTION 4
        // ======================================================

        if (action === 4) {

          Logger.log(
            "ACTION 4 - waiting for GUI."
          );

          return;
        }


        // ======================================================
        // ACTION 5
        // ======================================================

        if (action === 5) {

          action5Processed++;

          processAction5(
            fermentor
          );

          return;
        }


        // ======================================================
        // UNKNOWN ACTION
        // ======================================================

        Logger.log(
          "Unknown ACTION: " +
          action
        );

      } catch (
        error
      ) {

        Logger.log(
          "ERROR processing tank " +
          tankNumber +
          ": " +
          error.message
        );

        Logger.log(
          error.stack
        );
      }
    }
  );


  Logger.log("========================================");

  Logger.log(
    "ACTION 0 processed: " +
    action0Processed
  );

  Logger.log(
    "ACTION 1 processed: " +
    action1Processed
  );

  Logger.log(
    "ACTION 5 processed: " +
    action5Processed
  );

  Logger.log(
    "BREW ACTION SERVICE FINISHED"
  );

  Logger.log("========================================");
}


// ============================================================
// ACTION 0
// ============================================================
//
// IMPORTANT:
// We DO NOT search the brew folder here.
//
// We only inspect the current sheetUrl stored on the
// fermentor.
//
// If:
//   brewDate exists
//   AND brewDate is valid
//   AND brewDate >= today
//
// then ACTION becomes 1.
//
// ============================================================

function processAction0(
  fermentor
) {

  const tankNumber =
    String(
      fermentor.tankNumber || ""
    ).trim();


  const sheetUrl =
    String(
      fermentor.sheetUrl || ""
    ).trim();


  Logger.log(
    "ACTION 0: checking CURRENT sheet only for tank " +
    tankNumber
  );


  // ----------------------------------------------------------
  // NO CURRENT SHEET
  // ----------------------------------------------------------

  if (!sheetUrl) {

    Logger.log(
      "No sheetUrl found. ACTION remains 0."
    );

    return;
  }


  Logger.log(
    "Current sheet: " +
    sheetUrl
  );


  // ----------------------------------------------------------
  // EXTRACT CURRENT BREW
  // ----------------------------------------------------------

  let brew;


  try {

    brew =
      extractBrew(
        sheetUrl
      );

  } catch (
    error
  ) {

    Logger.log(
      "extractBrew failed: " +
      error.message
    );

    Logger.log(
      "ACTION remains 0."
    );

    return;
  }


  if (!brew) {

    Logger.log(
      "extractBrew returned no data."
    );

    return;
  }


  Logger.log(
    "Current sheet brewDate = " +
    brew.brewDate
  );


  // ----------------------------------------------------------
  // VALIDATE BREW DATE
  // ----------------------------------------------------------

  const brewDate =
    parseBrewDateForAction(
      brew.brewDate
    );


  if (!brewDate) {

    Logger.log(
      "No valid brewDate found in CURRENT sheet."
    );

    Logger.log(
      "ACTION remains 0."
    );

    return;
  }


  // ----------------------------------------------------------
  // TODAY
  // ----------------------------------------------------------

  const today =
    new Date();

  today.setHours(
    0,
    0,
    0,
    0
  );


  brewDate.setHours(
    0,
    0,
    0,
    0
  );


  Logger.log(
    "brewDate = " +
    formatActionDate(
      brewDate
    )
  );

  Logger.log(
    "today = " +
    formatActionDate(
      today
    )
  );


  // ----------------------------------------------------------
  // BREW DATE <= TODAY
  // ----------------------------------------------------------

  if (
    brewDate.getTime() <=
    today.getTime()
  ) {

    Logger.log(
      "Valid brewDate found in current sheet."
    );

    Logger.log(
      "ACTION 0 -> ACTION 1"
    );


    updateFermentorAction(
      tankNumber,
      1
    );


  } else {

    Logger.log(
      "brewDate is before today."
    );

    Logger.log(
      "ACTION remains 0."
    );
  }
}


// ============================================================
// ACTION 1
// ============================================================
//
// Check Firebase fermentor.tankStatus.
//
// If TRUE:
// ACTION 1 -> ACTION 3
//
// ============================================================

function processAction1(
  fermentor
) {

  const tankNumber =
    String(
      fermentor.tankNumber || ""
    ).trim();


  Logger.log(
    "ACTION 1: checking tankStatus for tank " +
    tankNumber
  );


  const firebaseFermentor =
    getFermentorFromFirebase(
      tankNumber
    );


  if (!firebaseFermentor) {

    Logger.log(
      "Fermentor not found in Firebase."
    );

    return;
  }


  const tankStatus =
    firebaseFermentor.tankStatus;


  Logger.log(
    "Firebase tankStatus = " +
    tankStatus +
    " | type = " +
    typeof tankStatus
  );


  // ----------------------------------------------------------
  // NORMALIZE tankStatus
  // ----------------------------------------------------------

  const tankStatusIsTrue =
    (
      tankStatus === true ||
      String(
        tankStatus
      ).trim().toUpperCase() === "TRUE"
    );


  Logger.log(
    "Normalized tankStatus = " +
    tankStatusIsTrue
  );


  // ----------------------------------------------------------
  // TRUE -> ACTION 3
  // ----------------------------------------------------------

  if (
    tankStatusIsTrue
  ) {

    Logger.log(
      "tankStatus is TRUE."
    );

    Logger.log(
      "ACTION 1 -> ACTION 3"
    );


    updateFermentorAction(
      tankNumber,
      3
    );


  } else {

    Logger.log(
      "tankStatus is not TRUE. ACTION remains 1."
    );
  }
}


// ============================================================
// ACTION 5
// ============================================================
//
// Search BREW_FOLDER_ID recursively.
//
// 1. Find all Google Sheets in folder + subfolders.
// 2. Filter filename by # + at least 4 digits.
// 3. Extract batch number from filename.
// 4. Keep only batch > current batch.
// 5. Sort ascending.
// 6. For candidates:
//      extractBrew()
//      check tankNumber
// 7. If matching tank:
//      uploadBrewToFirebase()
//      update sheetUrl
//      ACTION -> 0
//
// ============================================================

function processAction5(
  fermentor
) {

  const tankNumber =
    String(
      fermentor.tankNumber || ""
    ).trim();


  const currentBatch =
    parseBatchNumber(
      fermentor.batchNumber
    );


  Logger.log(
    "ACTION 5: searching next brew for tank " +
    tankNumber
  );

  Logger.log(
    "Current batch: " +
    currentBatch
  );


  if (
    currentBatch === null
  ) {

    Logger.log(
      "Invalid current batch. Cannot search."
    );

    return;
  }


  const nextBrew =
    findNextBrewForTankRecursive(
      tankNumber,
      currentBatch
    );


  if (!nextBrew) {

    Logger.log(
      "No next brew found for tank " +
      tankNumber
    );

    return;
  }


  // ----------------------------------------------------------
  // FOUND
  // ----------------------------------------------------------

  Logger.log(
    "========================================"
  );

  Logger.log(
    "NEXT BREW FOUND"
  );

  Logger.log(
    JSON.stringify(
      nextBrew,
      null,
      2
    )
  );

  Logger.log(
    "========================================"
  );


  // ----------------------------------------------------------
  // UPLOAD NEW BREW
  // ----------------------------------------------------------

  Logger.log(
    "Uploading new brew to Firebase..."
  );


  uploadBrewToFirebase(
    nextBrew.sheetUrl
  );


  // ----------------------------------------------------------
  // UPDATE FERMENTOR SHEET URL
  // ----------------------------------------------------------

  Logger.log(
    "Updating fermentor sheetUrl..."
  );


  updateFermentorSheetUrl(
    tankNumber,
    nextBrew.sheetUrl
  );


  // ----------------------------------------------------------
  // ACTION 5 -> ACTION 0
  // ----------------------------------------------------------

  Logger.log(
    "ACTION 5 -> ACTION 0"
  );


  updateFermentorAction(
    tankNumber,
    0
  );


  Logger.log(
    "ACTION 5 completed successfully for tank " +
    tankNumber
  );
}


// ============================================================
// FIND NEXT BREW - RECURSIVE
// ============================================================
//
// This is the important change.
//
// It searches:
//   BREW_FOLDER_ID
//   ├── files
//   ├── subfolder
//   │   ├── files
//   │   └── subfolder
//   │       └── files
//   └── ...
//
// ============================================================

function findNextBrewForTankRecursive(
  tankNumber,
  currentBatch
) {

  Logger.log(
    "========================================"
  );

  Logger.log(
    "ACTION 5 SEARCH"
  );

  Logger.log(
    "Tank: " +
    tankNumber
  );

  Logger.log(
    "Current batch: " +
    currentBatch
  );


  const rootFolder =
    DriveApp.getFolderById(
      BREW_FOLDER_ID
    );


  // ----------------------------------------------------------
  // COLLECT ALL SHEETS RECURSIVELY
  // ----------------------------------------------------------

  const files =
    [];


  collectGoogleSheetsRecursive(
    rootFolder,
    files
  );


  Logger.log(
    "Total Google Sheets found recursively: " +
    files.length
  );


  // ----------------------------------------------------------
  // FILTER FILENAMES
  // ----------------------------------------------------------

  const candidates =
    [];


  let filenameMatches = 0;


  files.forEach(
    function(file) {

      const fileName =
        file.getName();


      const batchFromFilename =
        extractBatchFromFilename(
          fileName
        );


      if (
        batchFromFilename === null
      ) {

        return;
      }


      filenameMatches++;


      // ------------------------------------------------------
      // FUTURE BATCH ONLY
      // ------------------------------------------------------

      if (
        batchFromFilename <=
        currentBatch
      ) {

        return;
      }


      candidates.push({

        file:
          file,

        batch:
          batchFromFilename,

        fileName:
          fileName,

        sheetUrl:
          file.getUrl(),

        fileId:
          file.getId()
      });
    }
  );


  Logger.log(
    "Filename matches: " +
    filenameMatches
  );

  Logger.log(
    "Future batches: " +
    candidates.length
  );


  // ----------------------------------------------------------
  // SORT BY BATCH
  // ----------------------------------------------------------

  candidates.sort(
    function(a, b) {

      return a.batch - b.batch;
    }
  );


  // ----------------------------------------------------------
  // CHECK CANDIDATES
  // ----------------------------------------------------------

  let tankMatches = 0;


  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    const candidate =
      candidates[i];


    Logger.log(
      "Checking candidate: " +
      candidate.fileName +
      " | batch=" +
      candidate.batch
    );


    let brew;


    try {

      brew =
        extractBrew(
          candidate.fileId
        );

    } catch (
      error
    ) {

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


    // --------------------------------------------------------
    // LOG EXTRACT RESULT
    // --------------------------------------------------------

    Logger.log(
      "Candidate extractBrew:"
    );

    Logger.log(
      JSON.stringify(
        brew,
        null,
        2
      )
    );


    // --------------------------------------------------------
    // IMPORTANT:
    // DO NOT TRUST extractBrew BATCH NUMBER HERE.
    //
    // The filename is what selected this candidate.
    // We use extractBrew only to inspect the actual sheet
    // and find its tank number.
    // --------------------------------------------------------

    const extractedTank =
      normalizeTankNumber(
        brew.tankNumber
      );


    const targetTank =
      normalizeTankNumber(
        tankNumber
      );


    Logger.log(
      "ACTION 5 tank check: " +
      "extractBrew=" +
      extractedTank +
      " | target=" +
      targetTank
    );


    if (
      !tankNumbersEqual(
        extractedTank,
        targetTank
      )
    ) {

      Logger.log(
        "Tank does not match. Skipping."
      );

      continue;
    }


    // --------------------------------------------------------
    // TANK MATCH
    // --------------------------------------------------------

    tankMatches++;


    Logger.log(
      "TANK MATCH FOUND!"
    );


    return {

      found:
        true,

      batchNumber:
        String(
          candidate.batch
        ),

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
        candidate.sheetUrl,

      fileId:
        candidate.fileId,

      fileName:
        candidate.fileName
    };
  }


  Logger.log(
    "Tank matches: " +
    tankMatches
  );

  Logger.log(
    "No next brew found."
  );

  Logger.log(
    "========================================"
  );


  return null;
}


// ============================================================
// COLLECT GOOGLE SHEETS RECURSIVELY
// ============================================================

function collectGoogleSheetsRecursive(
  folder,
  result
) {

  // ----------------------------------------------------------
  // FILES IN CURRENT FOLDER
  // ----------------------------------------------------------

  const files =
    folder.getFiles();


  while (
    files.hasNext()
  ) {

    const file =
      files.next();


    if (
      file.getMimeType() ===
      MimeType.GOOGLE_SHEETS
    ) {

      result.push(
        file
      );
    }
  }


  // ----------------------------------------------------------
  // SUBFOLDERS
  // ----------------------------------------------------------

  const folders =
    folder.getFolders();


  while (
    folders.hasNext()
  ) {

    const subFolder =
      folders.next();


    collectGoogleSheetsRecursive(
      subFolder,
      result
    );
  }
}


// ============================================================
// EXTRACT BATCH NUMBER FROM FILENAME
// ============================================================
//
// Examples:
//
// "IPA משולש 1578#"
// "IPA משולש 1578# משהו"
// "IPA 1601#"
//
// The requirement is:
// # followed by at least 4 digits.
//
// We take the digits immediately BEFORE #.
//
// ============================================================

function extractBatchFromFilename(
  fileName
) {

  if (!fileName) {
    return null;
  }


  const text =
    String(
      fileName
    ).trim();


  // ----------------------------------------------------------
  // Primary format:
  //
//      1578#
//
// At least 4 digits immediately before #.
// ----------------------------------------------------------

  let match =
    text.match(
      /(\d{4,})\s*#/
    );


  if (match) {

    const batch =
      Number(
        match[1]
      );


    if (
      Number.isFinite(batch)
    ) {

      return batch;
    }
  }


  // ----------------------------------------------------------
  // Optional fallback:
  //
// Some filenames may contain:
// "#1578"
//
// This is still a valid hash + 4 digit format.
// ----------------------------------------------------------

  match =
    text.match(
      /#\s*(\d{4,})/
    );


  if (match) {

    const batch =
      Number(
        match[1]
      );


    if (
      Number.isFinite(batch)
    ) {

      return batch;
    }
  }


  return null;
}


// ============================================================
// NORMALIZE TANK NUMBER
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


  return String(
    value
  )
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
    normalizeTankNumber(
      a
    );

  const right =
    normalizeTankNumber(
      b
    );


  if (
    !left ||
    !right
  ) {

    return false;
  }


  // ----------------------------------------------------------
  // Exact comparison
  // ----------------------------------------------------------

  if (
    left === right
  ) {

    return true;
  }


  // ----------------------------------------------------------
  // Numeric comparison
  //
  // "03" == "3"
  // ----------------------------------------------------------

  const leftNumber =
    Number(left);

  const rightNumber =
    Number(right);


  if (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber)
  ) {

    return (
      leftNumber ===
      rightNumber
    );
  }


  return false;
}


// ============================================================
// PARSE ACTION
// ============================================================

function parseAction(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }


  const number =
    Number(
      value
    );


  if (
    !Number.isFinite(number)
  ) {

    return null;
  }


  return number;
}


// ============================================================
// PARSE BREW DATE FOR ACTION 0
// ============================================================
//
// extractBrew() currently returns brewDate as a STRING.
//
// We intentionally do NOT modify extractBrew().
//
// Supported:
//
// DD/MM/YYYY
// D/M/YYYY
// DD/MM/YY
// D/M/YY
//
// Also supports Google Sheets date strings that can be parsed
// by JavaScript as a fallback.
//
// ============================================================

function parseBrewDateForAction(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }


  const text =
    String(
      value
    ).trim();


  if (!text) {
    return null;
  }


  // ----------------------------------------------------------
  // Israeli date
  // ----------------------------------------------------------

  const israeliMatch =
    text.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
    );


  if (
    israeliMatch
  ) {

    const day =
      Number(
        israeliMatch[1]
      );

    const month =
      Number(
        israeliMatch[2]
      ) - 1;

    let year =
      Number(
        israeliMatch[3]
      );


    if (
      year < 100
    ) {

      year += 2000;
    }


    const date =
      new Date(
        year,
        month,
        day
      );


    // --------------------------------------------------------
    // Validate that JS didn't normalize an invalid date.
    // --------------------------------------------------------

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month ||
      date.getDate() !== day
    ) {

      return null;
    }


    return date;
  }


  // ----------------------------------------------------------
  // Fallback
  // ----------------------------------------------------------

  const parsed =
    new Date(
      text
    );


  if (
    !isNaN(
      parsed.getTime()
    )
  ) {

    return parsed;
  }


  return null;
}


// ============================================================
// FORMAT DATE FOR LOG
// ============================================================

function formatActionDate(
  date
) {

  if (!date) {
    return "";
  }


  const day =
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    );


  const month =
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    );


  const year =
    date.getFullYear();


  return (
    day +
    "/" +
    month +
    "/" +
    year
  );
}


// ============================================================
// GET ALL FERMENTORS FROM FIREBASE
// ============================================================

function getAllFermentorsFromFirebase() {

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors";


  const response =
    UrlFetchApp.fetch(
      url,
      {

        method: "get",

        headers: {

          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        muteHttpExceptions:
          true
      }
    );


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
    function(document) {

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


      // ------------------------------------------------------
      // Fallback UID from document name
      // ------------------------------------------------------

      if (
        !result.uid
      ) {

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
// GET SINGLE FERMENTOR
// ============================================================

function getFermentorFromFirebase(
  tankNumber
) {

  const fermentorId =
    String(
      tankNumber
    ).trim();


  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    );


  const document =
    getFirestoreDocument(
      url
    );


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
// UPDATE FERMENTOR ACTION
// ============================================================

function updateFermentorAction(
  tankNumber,
  action
) {

  const fermentorId =
    String(
      tankNumber
    ).trim();


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
        toFirestoreValue(
          action
        )
    }
  };


  const response =
    UrlFetchApp.fetch(
      url,
      {

        method: "patch",

        contentType:
          "application/json",

        headers: {

          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify(
            document
          ),

        muteHttpExceptions:
          true
      }
    );


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
// UPDATE FERMENTOR SHEET URL
// ============================================================

function updateFermentorSheetUrl(
  tankNumber,
  sheetUrl
) {

  const fermentorId =
    String(
      tankNumber
    ).trim();


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
        toFirestoreValue(
          sheetUrl
        )
    }
  };


  const response =
    UrlFetchApp.fetch(
      url,
      {

        method: "patch",

        contentType:
          "application/json",

        headers: {

          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify(
            document
          ),

        muteHttpExceptions:
          true
      }
    );


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


  Logger.log(
    "Updated tank " +
    fermentorId +
    " sheetUrl -> " +
    sheetUrl
  );
}


// ============================================================
// TEST ACTION 0
// ============================================================

function testBrewAction0() {

  const tankNumber =
    "19";


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


  Logger.log(
    JSON.stringify(
      fermentor,
      null,
      2
    )
  );


  processAction0(
    fermentor
  );
}


// ============================================================
// TEST ACTION 5
// ============================================================

function testBrewAction5() {

  const tankNumber =
    "13";

  const currentBatch =
    1566;


  const result =
    findNextBrewForTankRecursive(
      tankNumber,
      currentBatch
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