// ============================================================
// BACKFILL BREWS SERVICE
// ============================================================
//
// PURPOSE:
// Fill missing historical BREWS + measurements in Firestore.
//
// IMPORTANT:
// - Does NOT update fermentors.
// - Does NOT use uploadBrewToFirebase().
// - Uses filename batch number.
// - Existing brews are not rewritten.
// - Existing measurements are not rewritten if unchanged.
// - Maximum 15,000 successful Firestore writes per run.
// - Starts from batch 1325 and works DOWN.
// - Batches higher than 1325 are ignored.
// - Safe to run again the next day.
//
// ============================================================

const BACKFILL_MAX_WRITES = 15000;

const BACKFILL_START_BATCH = 1325;


// ============================================================
// MAIN BACKFILL SERVICE
// ============================================================

function backfillBrewsService() {

  Logger.log("========================================");
  Logger.log("START BREW BACKFILL SERVICE");
  Logger.log(
    "START BATCH: " +
    BACKFILL_START_BATCH
  );
  Logger.log(
    "MAX WRITES: " +
    BACKFILL_MAX_WRITES
  );
  Logger.log("========================================");


  const projectId =
    FIREBASE_PROJECT_ID;


  if (!projectId) {

    throw new Error(
      "FIREBASE_PROJECT_ID is required."
    );
  }


  // ----------------------------------------------------------
  // WRITE COUNTER
  // ----------------------------------------------------------

  const writeCounter = {

    count: 0,

    limit:
      BACKFILL_MAX_WRITES,

    stopped:
      false
  };


  // ----------------------------------------------------------
  // GET EXISTING BREWS
  // ----------------------------------------------------------

  Logger.log(
    "Loading existing BREWS..."
  );


  const existingBrews =
    getAllBrewsFromFirestore(
      projectId
    );


  const existingBrewIds =
    {};


  existingBrews.forEach(
    function(brew) {

      if (
        brew &&
        brew.id
      ) {

        existingBrewIds[
          String(
            brew.id
          ).trim()
        ] = true;
      }
    }
  );


  Logger.log(
    "Existing BREWS: " +
    existingBrews.length
  );


  // ----------------------------------------------------------
  // COLLECT ALL GOOGLE SHEETS
  // ----------------------------------------------------------

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
    "Google Sheets found: " +
    files.length
  );


  // ----------------------------------------------------------
  // BUILD CANDIDATES
  // ----------------------------------------------------------

  const candidates = [];


  let invalidFilenameCount = 0;

  let aboveStartBatchCount = 0;


  files.forEach(
    function(file) {

      const fileName =
        file.getName();


      const batch =
        extractBatchFromFilename(
          fileName
        );


      // ------------------------------------------------------
      // INVALID BATCH NUMBER
      // ------------------------------------------------------

      if (
        batch === null
      ) {

        invalidFilenameCount++;

        return;
      }


      // ------------------------------------------------------
      // IGNORE BATCHES ABOVE START BATCH
      // ------------------------------------------------------

      if (
        Number(batch) <
        BACKFILL_START_BATCH
      ) {

        aboveStartBatchCount++;

        return;
      }


      candidates.push({

        file:
          file,

        fileId:
          file.getId(),

        fileName:
          fileName,

        sheetUrl:
          file.getUrl(),

        batch:
          batch
      });

    }
  );


  // ----------------------------------------------------------
  // SORT HIGH -> LOW
  // ----------------------------------------------------------

  candidates.sort(
    function(a, b) {

      return (
        Number(b.batch) -
        Number(a.batch)
      );

    }
  );


  Logger.log(
    "Valid brew files from " +
    BACKFILL_START_BATCH +
    " down: " +
    candidates.length
  );


  Logger.log(
    "Files above start batch ignored: " +
    aboveStartBatchCount
  );


  Logger.log(
    "Files without valid batch number: " +
    invalidFilenameCount
  );


  // ----------------------------------------------------------
  // STATISTICS
  // ----------------------------------------------------------

  let brewsCreated = 0;

  let brewsSkipped = 0;

  let filesProcessed = 0;

  let filesSkipped = 0;

  let extractFailed = 0;


  // ----------------------------------------------------------
  // PROCESS FILES
  // ----------------------------------------------------------

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    // --------------------------------------------------------
    // WRITE LIMIT
    // --------------------------------------------------------

    if (
      writeCounter.count >=
      writeCounter.limit
    ) {

      writeCounter.stopped =
        true;


      Logger.log(
        "WRITE LIMIT REACHED: " +
        writeCounter.count
      );


      break;
    }


    const candidate =
      candidates[i];


    const documentId =
      String(
        candidate.batch
      ).trim();


    // --------------------------------------------------------
    // CHECK EXISTING BREW
    // --------------------------------------------------------

    const brewExists =
      existingBrewIds[
        documentId
      ] === true;


    let brew = null;


    // ========================================================
    // EXISTING BREW
    // ========================================================

    if (
      brewExists
    ) {

      brewsSkipped++;


      Logger.log(
        "EXISTING brew " +
        documentId +
        " - checking measurements"
      );


      // ------------------------------------------------------
      // We still need the Sheet to read historical
      // measurements.
      // ------------------------------------------------------

      try {

        uploadHistoricalMeasurements(
          projectId,
          documentId,
          candidate.sheetUrl,
          writeCounter
        );

      } catch (
        error
      ) {

        if (
          error &&
          error.backfillWriteLimitReached
        ) {

          writeCounter.stopped =
            true;


          Logger.log(
            "WRITE LIMIT reached while processing brew " +
            documentId
          );


          break;
        }


        Logger.log(
          "ERROR processing measurements for brew " +
          documentId +
          ": " +
          error.message
        );


        Logger.log(
          error.stack
        );

      }


      filesProcessed++;


      continue;
    }


    // ========================================================
    // NEW BREW
    // ========================================================

    Logger.log(
      "NEW brew candidate: " +
      documentId +
      " | " +
      candidate.fileName
    );


    // --------------------------------------------------------
    // EXTRACT BREW
    // --------------------------------------------------------

    try {

      brew =
        extractBrew(
          candidate.fileId
        );

    } catch (
      error
    ) {

      extractFailed++;


      Logger.log(
        "extractBrew FAILED for " +
        candidate.fileName +
        ": " +
        error.message
      );


      continue;
    }


    if (!brew) {

      extractFailed++;


      Logger.log(
        "extractBrew returned no data: " +
        candidate.fileName
      );


      continue;
    }


    // --------------------------------------------------------
    // IMPORTANT:
    // Filename is authoritative for batch number.
    // --------------------------------------------------------

    brew.batchNumber =
      documentId;


    brew.uid =
      documentId;


    // --------------------------------------------------------
    // WRITE BREW
    // --------------------------------------------------------

    if (
      writeCounter.count >=
      writeCounter.limit
    ) {

      writeCounter.stopped =
        true;


      break;
    }


    writeBackfillFirestoreDocument(
      projectId,
      "brews/" +
        encodeURIComponent(
          documentId
        ),
      brew,
      writeCounter
    );


    brewsCreated++;


    existingBrewIds[
      documentId
    ] = true;


    // --------------------------------------------------------
    // HISTORICAL MEASUREMENTS
    // --------------------------------------------------------

    try {

      uploadHistoricalMeasurements(
        projectId,
        documentId,
        candidate.sheetUrl,
        writeCounter
      );

    } catch (
      error
    ) {

      if (
        error &&
        error.backfillWriteLimitReached
      ) {

        writeCounter.stopped =
          true;


        Logger.log(
          "WRITE LIMIT reached while processing brew " +
          documentId
        );


        break;
      }


      Logger.log(
        "ERROR processing measurements for brew " +
        documentId +
        ": " +
        error.message
      );


      Logger.log(
        error.stack
      );

    }


    filesProcessed++;


    // --------------------------------------------------------
    // STOP AFTER MEASUREMENTS
    // --------------------------------------------------------

    if (
      writeCounter.count >=
      writeCounter.limit
    ) {

      writeCounter.stopped =
        true;


      Logger.log(
        "WRITE LIMIT REACHED."
      );


      break;
    }

  }


  // ==========================================================
  // SUMMARY
  // ==========================================================

  Logger.log(
    "========================================"
  );


  Logger.log(
    "BREW BACKFILL FINISHED"
  );


  Logger.log(
    "Start batch: " +
    BACKFILL_START_BATCH
  );


  Logger.log(
    "Direction: HIGH -> LOW"
  );


  Logger.log(
    "Files processed: " +
    filesProcessed
  );


  Logger.log(
    "Files skipped: " +
    filesSkipped
  );


  Logger.log(
    "BREWS created: " +
    brewsCreated
  );


  Logger.log(
    "BREWS already existing: " +
    brewsSkipped
  );


  Logger.log(
    "extractBrew failures: " +
    extractFailed
  );


  Logger.log(
    "Firestore writes: " +
    writeCounter.count
  );


  Logger.log(
    "Writes remaining: " +
    Math.max(
      0,
      writeCounter.limit -
      writeCounter.count
    )
  );


  Logger.log(
    "Stopped by write limit: " +
    writeCounter.stopped
  );


  Logger.log(
    "========================================"
  );

}


// ============================================================
// BACKFILL FIRESTORE WRITE
// ============================================================
//
// ONLY this function performs counted writes.
//
// GET requests are NOT counted.
//
// The counter is incremented only AFTER a successful PATCH.
//
// ============================================================

function writeBackfillFirestoreDocument(
  projectId,
  documentPath,
  data,
  writeCounter
) {

  // ----------------------------------------------------------
  // SAFETY CHECK
  // ----------------------------------------------------------

  if (
    writeCounter.count >=
    writeCounter.limit
  ) {

    const error =
      new Error(
        "Backfill Firestore write limit reached."
      );


    error.backfillWriteLimitReached =
      true;


    throw error;
  }


  const url =
    "https://firestore.googleapis.com/v1/" +
    "projects/" +
    encodeURIComponent(
      projectId
    ) +
    "/databases/(default)/documents/" +
    documentPath;


  const document = {

    fields:
      toFirestoreFields(
        data
      )
  };


  const response =
    UrlFetchApp.fetch(
      url,
      {

        method:
          "patch",

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
      "Backfill Firestore write failed: " +
      code +
      " " +
      response.getContentText()
    );
  }


  // ----------------------------------------------------------
  // COUNT ONLY SUCCESSFUL WRITE
  // ----------------------------------------------------------

  writeCounter.count++;


  Logger.log(
    "WRITE #" +
    writeCounter.count +
    " | " +
    documentPath
  );


  return JSON.parse(
    response.getContentText()
  );

}


// ============================================================
// UPLOAD HISTORICAL MEASUREMENTS - BACKFILL VERSION
// ============================================================
//
// Same logic as the existing function.
//
// Difference:
// It receives writeCounter and stops at exactly the configured
// write limit.
//
// Existing unchanged measurements are NOT counted as writes.
//
// ============================================================

function uploadHistoricalMeasurements(
  projectId,
  batchId,
  sheetUrl,
  writeCounter
) {

  // ----------------------------------------------------------
  // BACKWARD COMPATIBILITY
  // ----------------------------------------------------------

  if (
    !writeCounter
  ) {

    writeCounter = {

      count: 0,

      limit:
        Number.MAX_SAFE_INTEGER,

      stopped:
        false
    };

  }


  const spreadsheetId =
    extractSpreadsheetId(
      sheetUrl
    );


  const ss =
    SpreadsheetApp.openById(
      spreadsheetId
    );


  const sheet =
    ss.getSheets()[0];


  const values =
    sheet
      .getDataRange()
      .getDisplayValues();


  const headerRow =
    findRowContaining(
      values,
      "טמפרטורה"
    );


  if (
    headerRow === -1
  ) {

    Logger.log(
      "No fermentation table found for brew " +
      batchId
    );


    return;
  }


  let savedCount = 0;

  let skippedCount = 0;


  for (
    let r = headerRow + 1;
    r < values.length;
    r++
  ) {

    // --------------------------------------------------------
    // CHECK WRITE LIMIT BEFORE PROCESSING NEXT ROW
    // --------------------------------------------------------

    if (
      writeCounter.count >=
      writeCounter.limit
    ) {

      writeCounter.stopped =
        true;


      const limitError =
        new Error(
          "Backfill write limit reached."
        );


      limitError.backfillWriteLimitReached =
        true;


      throw limitError;
    }


    const dateText =
      String(
        values[r][0] || ""
      ).trim();


    const date =
      parseIsraeliDate(
        dateText
      );


    if (!date) {

      continue;
    }


    const time =
      String(
        values[r][1] || ""
      ).trim();


    // --------------------------------------------------------
    // EMPTY MEASUREMENT ROW
    // --------------------------------------------------------

    if (
      !values[r][2] &&
      !values[r][3] &&
      !values[r][4] &&
      !values[r][5] &&
      !values[r][6] &&
      !values[r][7]
    ) {

      continue;
    }


    const measurement = {

      date:
        dateText,

      time:
        time,

      temp:
        extractNumber(
          values[r][3]
        ),

      plato:
        extractNumber(
          values[r][2]
        ),

      pressure:
        extractNumber(
          values[r][4]
        ),

      carbonation:
        extractNumber(
          values[r][6]
        ),

      pH:
        extractNumber(
          values[r][5]
        ),

      notes:
        String(
          values[r][7] || ""
        ).trim()

    };


    const measurementId =
      createMeasurementId(
        date,
        time
      );


    const url =
      "https://firestore.googleapis.com/v1/projects/" +
      encodeURIComponent(
        projectId
      ) +
      "/databases/(default)/documents/brews/" +
      encodeURIComponent(
        batchId
      ) +
      "/measurements/" +
      encodeURIComponent(
        measurementId
      );


    // ========================================================
    // CHECK EXISTING MEASUREMENT
    // ========================================================

    const existing =
      getFirestoreDocument(
        url
      );


    let shouldWrite =
      true;


    if (
      existing &&
      existing.fields
    ) {

      const existingMeasurement =
        {};


      for (
        const key in existing.fields
      ) {

        existingMeasurement[key] =
          normalizeFirestoreValue(
            existing.fields[key]
          );

      }


      if (
        objectsEqual(
          measurement,
          existingMeasurement
        )
      ) {

        shouldWrite =
          false;
      }

    }


    // ========================================================
    // SKIP UNCHANGED
    // ========================================================

    if (
      !shouldWrite
    ) {

      skippedCount++;

      continue;
    }


    // ========================================================
    // WRITE
    // ========================================================

    // --------------------------------------------------------
    // IMPORTANT:
    // Check immediately before write.
    //
    // This guarantees we never intentionally perform
    // write #15001.
    // --------------------------------------------------------

    if (
      writeCounter.count >=
      writeCounter.limit
    ) {

      writeCounter.stopped =
        true;


      const limitError =
        new Error(
          "Backfill write limit reached."
        );


      limitError.backfillWriteLimitReached =
        true;


      throw limitError;
    }


    writeBackfillFirestoreDocument(
      projectId,
      "brews/" +
        encodeURIComponent(
          batchId
        ) +
        "/measurements/" +
        encodeURIComponent(
          measurementId
        ),
      measurement,
      writeCounter
    );


    savedCount++;

  }


  Logger.log(
    "Brew " +
    batchId +
    " | measurements saved: " +
    savedCount +
    " | skipped: " +
    skippedCount
  );

}