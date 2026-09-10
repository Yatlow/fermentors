// ============================================================
// SYNC HISTORICAL MEASUREMENTS FOR ACTIVE BREWS ONLY
// ============================================================
//
// Only brews that are currently inside a fermentor.
//
// We determine this from:
//
//   fermentors/*
//        ↓
//   batchNumber
//
// If a fermentor has a batchNumber,
// that brew is considered active.
//
// ============================================================

function syncActiveHistoricalMeasurements() {

  const projectId =
    FIREBASE_PROJECT_ID;

  Logger.log(
    "========================================"
  );

  Logger.log(
    "START ACTIVE HISTORICAL MEASUREMENTS SYNC"
  );


  const fermentors =
    getAllFermentorsFromFirestore(
      projectId
    );


  Logger.log(
    "Fermentors found: " +
    fermentors.length
  );


  let processed = 0;
  let skipped = 0;
  let failed = 0;


  // ==========================================================
  // PROCESS CURRENTLY ACTIVE FERMENTORS
  // ==========================================================

  fermentors.forEach(
    function (fermentor) {

      const fermentorId =
        fermentor.id;

      try {

        const data =
          fermentor.data || {};


        // ------------------------------------------------------
        // ONLY FERMENTORS WITH ACTIVE BREW
        // ------------------------------------------------------

        const batchNumber =
          String(
            data.batchNumber ||
            ""
          ).trim();


        if (!batchNumber) {

          Logger.log(
            "SKIPPED " +
            fermentorId +
            " - no active batch."
          );

          skipped++;

          return;
        }


        // ------------------------------------------------------
        // SHEET URL
        // ------------------------------------------------------

        const sheetUrl =
          String(
            data.sheetUrl ||
            ""
          ).trim();


        if (!sheetUrl) {

          Logger.log(
            "SKIPPED " +
            fermentorId +
            " - no sheetUrl."
          );

          skipped++;

          return;
        }


        // ------------------------------------------------------
        // UPLOAD HISTORICAL MEASUREMENTS
        // ------------------------------------------------------

        Logger.log(
          "Syncing historical measurements for batch " +
          batchNumber +
          " in fermentor " +
          fermentorId
        );


        uploadHistoricalMeasurements(
          projectId,
          batchNumber,
          sheetUrl
        );


        processed++;


        Logger.log(
          "Historical measurements synced: " +
          batchNumber
        );

      } catch (
        error
      ) {

        failed++;


        Logger.log(
          "ERROR historical sync for fermentor " +
          fermentorId +
          ": " +
          error.message
        );
      }
    }
  );


  // ==========================================================
  // SUMMARY
  // ==========================================================

  Logger.log(
    "========================================"
  );

  Logger.log(
    "ACTIVE HISTORICAL SYNC FINISHED"
  );

  Logger.log(
    "Processed: " +
    processed
  );

  Logger.log(
    "Skipped: " +
    skipped
  );

  Logger.log(
    "Failed: " +
    failed
  );

  Logger.log(
    "========================================"
  );
}