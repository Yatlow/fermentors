// ============================================================
// DAILY HISTORICAL DATA SERVICE
// ============================================================
//
// PURPOSE:
//
// Synchronize existing brews from Firestore with their
// original Google Sheets.
//
// IMPORTANT:
//
// This service DOES NOT scan Google Drive.
//
// Instead:
//
//   Firestore
//      ↓
//   brews collection
//      ↓
//   sheetUrl
//      ↓
//   extractBrew()
//      ↓
//   update brews/{batchNumber}
//      ↓
//   update historical measurements
//
//
// FIRESTORE STRUCTURE:
//
// brews/{batchNumber}
//
// brews/{batchNumber}/measurements/{measurementId}
//
//
// IMPORTANT:
//
// This service DOES NOT update:
//
//   fermentors/*
//
// Fermentor state is controlled separately by:
//
//   BREW ACTION SERVICE
//   FERMENTOR ACTION SERVICE
//
// ============================================================



// ============================================================
// MAIN DAILY SERVICE
// ============================================================

function dailyBrewSyncService() {

  Logger.log("========================================");
  Logger.log("START DAILY BREW SYNC SERVICE");
  Logger.log("========================================");


  // ----------------------------------------------------------
  // GET EXISTING BREWS FROM FIRESTORE
  // ----------------------------------------------------------

  const brews =
    getAllBrewsFromFirebase();


  Logger.log(
    "Brews found in Firestore: " +
    brews.length
  );


  let processed = 0;
  let synced = 0;
  let skipped = 0;
  let failed = 0;


  // ----------------------------------------------------------
  // PROCESS EACH BREW
  // ----------------------------------------------------------

  brews.forEach(
    function(brew) {

      processed++;


      const batchNumber =
        String(
          brew.batchNumber ||
          brew.uid ||
          ""
        ).trim();


      Logger.log("----------------------------------------");

      Logger.log(
        "Processing brew: " +
        batchNumber
      );


      // ------------------------------------------------------
      // VALIDATE SHEET URL
      // ------------------------------------------------------

      const sheetUrl =
        String(
          brew.sheetUrl ||
          ""
        ).trim();


      if (!sheetUrl) {

        Logger.log(
          "SKIPPED brew " +
          batchNumber +
          " - no sheetUrl."
        );

        skipped++;

        return;
      }


      // ------------------------------------------------------
      // SYNC
      // ------------------------------------------------------

      try {

        const result =
          syncBrewToFirebase(
            sheetUrl
          );


        if (
          result &&
          result.synced
        ) {

          synced++;

          Logger.log(
            "SYNCED brew " +
            batchNumber
          );

        } else {

          skipped++;

          Logger.log(
            "UNCHANGED brew " +
            batchNumber
          );
        }


      } catch (
        error
      ) {

        failed++;


        Logger.log(
          "FAILED brew " +
          batchNumber
        );

        Logger.log(
          error.message
        );

        Logger.log(
          error.stack
        );
      }
    }
  );


  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------

  Logger.log("========================================");

  Logger.log(
    "DAILY BREW SYNC FINISHED"
  );

  Logger.log(
    "Brews processed: " +
    processed
  );

  Logger.log(
    "Brews synced: " +
    synced
  );

  Logger.log(
    "Brews skipped: " +
    skipped
  );

  Logger.log(
    "Failed: " +
    failed
  );

  Logger.log("========================================");
}



// ============================================================
// GET ALL BREWS FROM FIRESTORE
// ============================================================
//
// Reads:
//
//   brews/*
//
// Does NOT scan Google Drive.
//
// Only returns documents that contain a valid sheetUrl.
//
// ============================================================

function getAllBrewsFromFirebase() {

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/brews";


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

        muteHttpExceptions: true
      }
    );


  const code =
    response.getResponseCode();


  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to get brews: " +
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


  const result = [];


  documents.forEach(
    function(document) {

      const fields =
        document.fields || {};


      const brew = {};


      // ------------------------------------------------------
      // CONVERT FIRESTORE VALUES
      // ------------------------------------------------------

      for (
        const key in fields
      ) {

        brew[key] =
          normalizeFirestoreValue(
            fields[key]
          );
      }


      // ------------------------------------------------------
      // FALLBACK UID FROM DOCUMENT NAME
      // ------------------------------------------------------

      if (!brew.uid) {

        const parts =
          String(
            document.name || ""
          ).split("/");


        brew.uid =
          parts[
            parts.length - 1
          ] || null;
      }


      // ------------------------------------------------------
      // ONLY REAL BREWS
      // ------------------------------------------------------
      //
      // We require a sheetUrl.
      //
      // This prevents documents such as:
      //
      //   טמפ
      //   תאריך
      //   סטטוס טמפרטורה
      //
      // from entering the sync process.
      //
      // ------------------------------------------------------

      const sheetUrl =
        String(
          brew.sheetUrl ||
          ""
        ).trim();


      if (!sheetUrl) {

        return;
      }


      // ------------------------------------------------------
      // OPTIONAL BATCH VALIDATION
      // ------------------------------------------------------

      const batchNumber =
        String(
          brew.batchNumber ||
          brew.uid ||
          ""
        ).trim();


      if (!batchNumber) {

        return;
      }


      brew.batchNumber =
        batchNumber;


      result.push(
        brew
      );
    }
  );


  return result;
}



// ============================================================
// SYNC ONE BREW
// ============================================================
//
// Reads the Google Sheet.
//
// Updates:
//
//   brews/{batchNumber}
//
// Then ALWAYS checks:
//
//   historical measurements
//
// This is important because measurements can change while
// the main brew information stays exactly the same.
//
// ============================================================

function syncBrewToFirebase(
  sheetUrl
) {

  if (!sheetUrl) {

    throw new Error(
      "No Google Sheet URL provided."
    );
  }


  Logger.log(
    "Syncing sheet: " +
    sheetUrl
  );


  // ==========================================================
  // EXTRACT BREW
  // ==========================================================

  const brew =
    extractBrew(
      sheetUrl
    );


  if (!brew) {

    throw new Error(
      "extractBrew() returned no data."
    );
  }


  // ==========================================================
  // VALIDATE BATCH
  // ==========================================================

  if (
    brew.batchNumber === null ||
    brew.batchNumber === undefined ||
    String(
      brew.batchNumber
    ).trim() === ""
  ) {

    throw new Error(
      "No batch number found in sheet."
    );
  }


  const documentId =
    String(
      brew.batchNumber
    ).trim();


  // ==========================================================
  // UID
  // ==========================================================

  brew.uid =
    documentId;


  // ==========================================================
  // FIRESTORE BREW URL
  // ==========================================================

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/brews/" +
    encodeURIComponent(
      documentId
    );


  // ==========================================================
  // GET EXISTING BREW
  // ==========================================================

  const existing =
    getFirestoreDocument(
      url
    );


  let existingData =
    null;


  if (
    existing &&
    existing.fields
  ) {

    existingData = {};


    for (
      const key in existing.fields
    ) {

      existingData[key] =
        normalizeFirestoreValue(
          existing.fields[key]
        );
    }
  }


  // ==========================================================
  // PREPARE COMPARISON
  // ==========================================================
  //
  // uid is derived from batchNumber.
  //
  // Therefore it should not cause a change.
  //
  // ==========================================================

  const brewForComparison =
    JSON.parse(
      JSON.stringify(
        brew
      )
    );


  delete brewForComparison.uid;


  let brewChanged =
    true;


  if (
    existingData
  ) {

    const existingForComparison =
      JSON.parse(
        JSON.stringify(
          existingData
        )
      );


    delete existingForComparison.uid;


    brewChanged =
      !objectsEqual(
        brewForComparison,
        existingForComparison
      );
  }


  // ==========================================================
  // UPDATE MAIN BREW DOCUMENT
  // ==========================================================

  if (
    brewChanged
  ) {

    const firestoreDocument = {

      fields:
        toFirestoreFields(
          brew
        )
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
              firestoreDocument
            ),

          muteHttpExceptions: true
        }
      );


    const code =
      response.getResponseCode();


    if (
      code < 200 ||
      code >= 300
    ) {

      throw new Error(
        "Firebase brew upload failed: " +
        code +
        " " +
        response.getContentText()
      );
    }


    Logger.log(
      "UPDATED brew: " +
      documentId
    );

  } else {

    Logger.log(
      "BREW unchanged: " +
      documentId
    );
  }


  // ==========================================================
  // HISTORICAL MEASUREMENTS
  // ==========================================================
  //
  // IMPORTANT:
  //
  // We ALWAYS execute this.
  //
  // Even if the main brew document did not change,
  // the Google Sheet may contain new measurements.
  //
  // ==========================================================

  Logger.log(
    "Checking historical measurements for brew " +
    documentId
  );


  uploadHistoricalMeasurements(
    FIREBASE_PROJECT_ID,
    documentId,
    sheetUrl
  );


  // ==========================================================
  // RESULT
  // ==========================================================

  Logger.log(
    "Finished sync for brew: " +
    documentId
  );


  return {

    synced:
      brewChanged,

    batchNumber:
      documentId
  };
}



// ============================================================
// TEST ONE BREW
// ============================================================
//
// Use this first before running the full daily service.
//
// ============================================================

function testSyncBrewToFirebase() {

  const sheetUrl =
    "https://docs.google.com/spreadsheets/d/1rUF3AsqGkJng9Z_0OoyJUVpPPtXcDHF3r7W49kOy30A/edit";


  const result =
    syncBrewToFirebase(
      sheetUrl
    );


  Logger.log(
    "========================================"
  );

  Logger.log(
    "TEST RESULT"
  );

  Logger.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );

  Logger.log(
    "========================================"
  );


  return result;
}



// ============================================================
// TEST DAILY SERVICE
// ============================================================

function testDailyBrewSyncService() {

  dailyBrewSyncService();

}



// ============================================================
// CREATE DAILY TRIGGER
// ============================================================
//
// Run this function ONCE manually.
//
// It deletes existing triggers for the same service and
// creates one daily trigger.
//
// ============================================================

function createDailyBrewSyncTrigger() {

  const functionName =
    "dailyBrewSyncService";


  // ----------------------------------------------------------
  // DELETE EXISTING TRIGGERS
  // ----------------------------------------------------------

  const triggers =
    ScriptApp.getProjectTriggers();


  triggers.forEach(
    function(trigger) {

      if (
        trigger.getHandlerFunction() ===
        functionName
      ) {

        ScriptApp.deleteTrigger(
          trigger
        );
      }
    }
  );


  // ----------------------------------------------------------
  // CREATE NEW DAILY TRIGGER
  // ----------------------------------------------------------

  ScriptApp
    .newTrigger(
      functionName
    )
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();


  Logger.log(
    "Created daily trigger for " +
    functionName +
    " at approximately 03:00."
  );
}