function assignManualBatch(
  tankNumber,
  requestedBatch
) {

  const tankID =
    String(
      tankNumber || ""
    ).trim();


  const batch =
    Number(
      requestedBatch
    );


  if (!tankID) {

    throw new Error(
      "Missing tankID"
    );
  }


  if (
    !Number.isFinite(batch)
  ) {

    throw new Error(
      "Invalid requestedBatch"
    );
  }


  Logger.log(
    "========================================"
  );

  Logger.log(
    "MANUAL BATCH ASSIGNMENT"
  );

  Logger.log(
    "Tank: " +
    tankID
  );

  Logger.log(
    "Batch: " +
    batch
  );

  Logger.log(
    "========================================"
  );


  // ----------------------------------------------------------
  // CHECK AGAIN BEFORE ASSIGNING
  //
  // IMPORTANT:
  // This is NOT a blocking validation.
  //
  // If the batch belongs to another tank,
  // we still allow the assignment.
  //
  // We only block if the batch cannot be found
  // or the sheet cannot be read.
  // ----------------------------------------------------------

  const check =
    checkBatchForTank(
      tankID,
      batch
    );


  Logger.log(
    "Assignment check result:"
  );

  Logger.log(
    JSON.stringify(
      check,
      null,
      2
    )
  );


  // ----------------------------------------------------------
  // BATCH DOES NOT EXIST
  // ----------------------------------------------------------

  if (
    check.reason ===
    "Batch not found"
  ) {

    throw new Error(
      "Batch " +
      batch +
      " was not found."
    );
  }


  // ----------------------------------------------------------
  // SHEET COULD NOT BE READ
  // ----------------------------------------------------------

  if (
    check.reason ===
    "Could not read batch sheet"
  ) {

    throw new Error(
      "Could not read batch " +
      batch +
      " sheet."
    );
  }


  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // check.valid === false because the tank doesn't match.
  //
  // THIS IS ONLY A WARNING.
  //
  // We intentionally DO NOT stop here.
  // ----------------------------------------------------------

  if (
    !check.valid
  ) {

    Logger.log(
      "WARNING: Batch " +
      batch +
      " belongs to tank " +
      check.actualTank +
      " instead of tank " +
      tankID
    );

    Logger.log(
      "User already confirmed manual assignment."
    );
  }


  // ----------------------------------------------------------
  // UPLOAD BREW TO FIREBASE
  // ----------------------------------------------------------

  Logger.log(
    "Uploading brew to Firebase..."
  );


  uploadBrewToFirebase(
    check.sheetUrl
  );


  // ----------------------------------------------------------
  // UPDATE FERMENTOR SHEET URL
  // ----------------------------------------------------------

  Logger.log(
    "Updating fermentor sheetUrl..."
  );


  updateFermentorSheetUrl(
    tankID,
    check.sheetUrl
  );


  // ----------------------------------------------------------
  // ACTION -> 0
  // ----------------------------------------------------------

  Logger.log(
    "Updating ACTION -> 0"
  );


  updateFermentorAction(
    tankID,
    0
  );


  Logger.log(
    "Manual batch assignment completed."
  );


  return {

    assigned:
      true,

    warning:
      !check.valid,

    batchNumber:
      check.batchNumber ||
      String(batch),

    tankNumber:
      tankID,

    originalTankNumber:
      check.actualTank || null,

    beerStyle:
      check.beerStyle,

    brewDate:
      check.brewDate,

    beerVolume:
      check.beerVolume,

    startingPlato:
      check.startingPlato,

    sheetUrl:
      check.sheetUrl,

    fileId:
      check.fileId,

    fileName:
      check.fileName

  };
}