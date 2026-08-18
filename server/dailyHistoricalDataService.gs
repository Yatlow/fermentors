// ============================================================
// DAILY BREW SYNC SERVICE
// ============================================================
//
// PURPOSE:
//
// Synchronize all brew Google Sheets with Firestore.
//
// This service updates:
//
//   brews/{batchNumber}
//
// and:
//
//   brews/{batchNumber}/measurements/{measurementId}
//
//
//
// IMPORTANT:
//
// This service DOES NOT update fermentors.
//
// Fermentor state is controlled separately by
// BREW ACTION SERVICE / FERMENTOR ACTION SERVICE.
//
//
//
// FLOW:
//
// dailyBrewSyncService()
//        |
//        v
// collect all Google Sheets recursively
//        |
//        v
// syncBrewToFirebase(sheetUrl)
//        |
//        +----> update brews/{batchNumber}
//        |
//        +----> update historical measurements
//
// ============================================================


// ============================================================
// DAILY BREW SYNC SERVICE
// ============================================================

function dailyBrewSyncService() {

  Logger.log("========================================");
  Logger.log("START DAILY BREW SYNC SERVICE");
  Logger.log("========================================");


  // ----------------------------------------------------------
  // ROOT FOLDER
  // ----------------------------------------------------------

  const rootFolder =
    DriveApp.getFolderById(
      BREW_FOLDER_ID
    );


  // ----------------------------------------------------------
  // COLLECT ALL GOOGLE SHEETS
  // ----------------------------------------------------------

  const files = [];


  collectGoogleSheetsRecursive(
    rootFolder,
    files
  );


  Logger.log(
    "Google Sheets found: " +
    files.length
  );


  let processed = 0;
  let synced = 0;
  let skipped = 0;
  let failed = 0;


  // ----------------------------------------------------------
  // PROCESS EACH SHEET
  // ----------------------------------------------------------

  files.forEach(
    function(file) {

      processed++;


      const fileName =
        file.getName();

      const sheetUrl =
        file.getUrl();


      Logger.log("----------------------------------------");

      Logger.log(
        "Processing: " +
        fileName
      );


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

        } else {

          skipped++;
        }


      } catch (
        error
      ) {

        failed++;


        Logger.log(
          "FAILED: " +
          fileName
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
    "Files processed: " +
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
// SYNC BREW TO FIREBASE
// ============================================================
//
// PURPOSE:
//
// Read one Google Sheet and synchronize:
//
//   brews/{batchNumber}
//
// and:
//
//   brews/{batchNumber}/measurements/*
//
//
//
// IMPORTANT:
//
// This function DOES NOT update:
//
//   fermentors/*
//
//
//
// That is intentional.
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
    "Syncing brew: " +
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

  if (!brew.batchNumber) {

    throw new Error(
      "No batch number found in sheet."
    );
  }


  const documentId =
    String(
      brew.batchNumber
    ).trim();


  if (!documentId) {

    throw new Error(
      "Invalid batch number."
    );
  }


  // ==========================================================
  // UID
  // ==========================================================

  brew.uid =
    documentId;


  // ==========================================================
  // FIRESTORE URL
  // ==========================================================

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/brews/" +
    encodeURIComponent(
      documentId
    );


  // ==========================================================
  // PREPARE COMPARISON OBJECT
  // ==========================================================
//
// We don't compare uid because uid is derived from
// batchNumber and is not meaningful for change detection.
//

  const brewForComparison =
    JSON.parse(
      JSON.stringify(
        brew
      )
    );


  delete brewForComparison.uid;


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
  // CHECK IF BREW CHANGED
  // ==========================================================

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
  // UPDATE BREW DOCUMENT
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
              firestoreDocument
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
// Even if the main brew document didn't change,
// we ALWAYS check measurements.
//
// This is critical.
//
// Example:
//
// Yesterday:
//
//   measurements:
//      15/08 10:00
//
// Today the brewer added:
//
//      16/08 10:00
//
// The brew document itself may be unchanged,
// but the new measurement must still be uploaded.
//

  uploadHistoricalMeasurements(
    FIREBASE_PROJECT_ID,
    documentId,
    sheetUrl
  );


  // ==========================================================
  // FINISHED
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
// TEST SINGLE BREW SYNC
// ============================================================
//
// Use this to test ONE sheet before creating the trigger.
//
// ============================================================

function testSyncBrewToFirebase() {

  const sheetUrl =
    "https://docs.google.com/spreadsheets/d/140dqVSyz4UCVFFgxVTVGgQoBlZYGqYF9jaybWr6lulk/edit?usp=drive_link";


  const result =
    syncBrewToFirebase(
      sheetUrl
    );


  Logger.log(
    "TEST RESULT:"
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



// ============================================================
// TEST DAILY BREW SYNC
// ============================================================
//
// Runs the complete daily synchronization manually.
//
// ============================================================

function testDailyBrewSyncService() {

  dailyBrewSyncService();

}



// ============================================================
// CREATE DAILY TRIGGER
// ============================================================
//
// Creates ONE trigger that runs once per day.
//
// IMPORTANT:
//
// Run this function manually ONCE.
//
// Do not run it every day.
//
// ============================================================

function createDailyBrewSyncTrigger() {

  const functionName =
    "dailyBrewSyncService";


  // ----------------------------------------------------------
  // REMOVE EXISTING TRIGGERS FOR THIS FUNCTION
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
  // CREATE DAILY TRIGGER
  // ----------------------------------------------------------

  ScriptApp.newTrigger(
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