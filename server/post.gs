
function doGet(e) {

  try {

    Logger.log("========================================");
    Logger.log("MANUAL BATCH CHECK");
    Logger.log("========================================");

    Logger.log(
      "GET event: " +
      JSON.stringify(e)
    );


    if (!e || !e.parameter) {
      throw new Error("No GET parameters received");
    }


    const action =
      e.parameter.action;


    if (
      action !== "CheckBatchAssignment"
    ) {

      throw new Error(
        "Unknown action: " +
        action
      );
    }


    const tankID =
      String(
        e.parameter.tankID || ""
      ).trim();


    const requestedBatch =
      Number(
        e.parameter.requestedBatch
      );


    if (!tankID) {
      throw new Error("Missing tankID");
    }


    if (
      !Number.isFinite(
        requestedBatch
      )
    ) {

      throw new Error(
        "Invalid requestedBatch"
      );
    }


    Logger.log(
      "Tank: " +
      tankID
    );

    Logger.log(
      "Requested batch: " +
      requestedBatch
    );


    // --------------------------------------------------------
    // CHECK ONLY
    // --------------------------------------------------------

    const result =
      checkBatchForTank(
        tankID,
        requestedBatch
      );


    return jsonResponse({

      success: true,

      result:
        result

    });


  } catch (error) {

    Logger.log(
      "doGet ERROR: " +
      error.stack
    );


    return jsonResponse({

      success: false,

      error:
        error.message

    });
  }
}


function doPost(e) {

  try {

    if (
      !e ||
      !e.postData ||
      !e.postData.contents
    ) {

      throw new Error(
        "No POST data received"
      );
    }


    const data =
      JSON.parse(
        e.postData.contents
      );


    Logger.log(
      "Received POST data: " +
      JSON.stringify(data)
    );


    // ========================================================
    // EXISTING: UPDATE TANK STATUS
    // ========================================================

    if (
      data.action ===
      "updateTankStatus"
    ) {

      updateTankStatus(
        data.fermentorID,
        data.tankAction,
        data.date,
        data.pasivationDate
      );


      return jsonResponse({

        success: true,

        action:
          "updateTankStatus",

        fermentorID:
          data.fermentorID,

        tankAction:
          data.tankAction,

        date:
          data.date,

        pasivationDate:
          data.pasivationDate

      });
    }


    // ========================================================
    // NEW: ASSIGN MANUAL BATCH
    // ========================================================

    if (
      data.action ===
      "AssignBatch"
    ) {

      const result =
        assignManualBatch(
          data.tankID,
          data.requestedBatch
        );


      return jsonResponse({

        success: true,

        action:
          "AssignBatch",

        result:
          result

      });
    }

    // ========================================================
    // NEW: ADD FERMENTATION MEASUREMENT TO GOOGLE SHEET
    // ========================================================

    if (
      data.action ===
      "addFermentationMeasurement"
    ) {

      const result =
        addFermentationMeasurement(
          data.sheetUrl,
          data.temperature,
          data.pressure,
          data.sugar,
          data.pH,
          data.carbonation,
          data.notes
        );


      return jsonResponse({

        success: true,

        action:
          "addFermentationMeasurement",

        result:
          result

      });
    }

    throw new Error(
      "Unknown action: " +
      data.action
    );


  } catch (error) {

    Logger.log(
      "doPost ERROR: " +
      error.stack
    );


    return jsonResponse({

      success: false,

      error:
        error.message

    });
  }
}

function checkBatchForTank(
  tankNumber,
  requestedBatch
) {

  const targetTank =
    normalizeTankNumber(
      tankNumber
    );


  const targetBatch =
    Number(
      requestedBatch
    );


  if (!targetTank) {

    throw new Error(
      "Invalid tank number"
    );
  }


  if (
    !Number.isFinite(
      targetBatch
    )
  ) {

    throw new Error(
      "Invalid batch number"
    );
  }


  Logger.log(
    "Checking batch " +
    targetBatch +
    " for tank " +
    targetTank
  );


  // ----------------------------------------------------------
  // FIND THE FILE WITH THIS BATCH NUMBER
  // ----------------------------------------------------------

  const rootFolder =
    DriveApp.getFolderById(
      BREW_FOLDER_ID
    );


  const files =
    [];


  collectGoogleSheetsRecursive(
    rootFolder,
    files
  );


  Logger.log(
    "Google Sheets found: " +
    files.length
  );


  // ----------------------------------------------------------
  // FIND EXACT BATCH
  // ----------------------------------------------------------

  const candidates =
    [];


  files.forEach(
    function (file) {

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


      if (
        batchFromFilename ===
        targetBatch
      ) {

        candidates.push(
          file
        );
      }
    }
  );


  // ----------------------------------------------------------
  // BATCH NOT FOUND
  // ----------------------------------------------------------

  if (
    candidates.length === 0
  ) {

    Logger.log(
      "Batch " +
      targetBatch +
      " not found."
    );


    return {

      valid: false,

      warning: true,

      reason:
        "Batch not found",

      requestedBatch:
        String(targetBatch),

      tankNumber:
        targetTank

    };
  }


  // ----------------------------------------------------------
  // CHECK CANDIDATES
  // ----------------------------------------------------------

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    const file =
      candidates[i];


    const fileName =
      file.getName();


    Logger.log(
      "Checking batch file: " +
      fileName
    );


    let brew;


    try {

      brew =
        extractBrew(
          file.getId()
        );

    } catch (error) {

      Logger.log(
        "extractBrew failed: " +
        error.message
      );

      continue;
    }


    if (!brew) {
      continue;
    }


    const actualTank =
      normalizeTankNumber(
        brew.tankNumber
      );


    Logger.log(
      "Requested tank: " +
      targetTank
    );

    Logger.log(
      "Actual tank in sheet: " +
      actualTank
    );


    // --------------------------------------------------------
    // TANK MATCH
    // --------------------------------------------------------

    if (
      tankNumbersEqual(
        actualTank,
        targetTank
      )
    ) {

      Logger.log(
        "BATCH IS VALID FOR TANK"
      );


      return {

        valid: true,

        warning: false,

        batchNumber:
          String(targetBatch),

        tankNumber:
          targetTank,

        beerStyle:
          brew.beerStyle,

        brewDate:
          brew.brewDate,

        beerVolume:
          brew.beerVolume,

        startingPlato:
          brew.startingPlato,

        sheetUrl:
          file.getUrl(),

        fileId:
          file.getId(),

        fileName:
          fileName

      };
    }


    // --------------------------------------------------------
    // TANK DOES NOT MATCH
    // --------------------------------------------------------

    Logger.log(
      "BATCH DOES NOT MATCH TANK"
    );


    return {

      valid: false,

      warning: true,

      reason:
        "Batch belongs to a different tank",

      requestedBatch:
        String(targetBatch),

      requestedTank:
        targetTank,

      actualTank:
        actualTank,

      beerStyle:
        brew.beerStyle,

      brewDate:
        brew.brewDate,

      sheetUrl:
        file.getUrl(),

      fileId:
        file.getId(),

      fileName:
        fileName

    };
  }


  // ----------------------------------------------------------
  // COULD NOT READ BATCH
  // ----------------------------------------------------------

  return {

    valid: false,

    warning: true,

    reason:
      "Could not read batch sheet",

    requestedBatch:
      String(targetBatch),

    tankNumber:
      targetTank

  };
}

// ============================================================
// ADD FERMENTATION MEASUREMENT TO GOOGLE SHEET
// ============================================================



// ============================================================
// FORMAT OPTIONAL MEASUREMENT VALUE
// ============================================================

function formatMeasurementValue(
  value
) {

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {

    return "";
  }


  // If it is already a number,
  // keep it as a number.

  if (
    typeof value === "number"
  ) {

    if (
      Number.isFinite(value)
    ) {

      return value;
    }

    return "";
  }


  const text =
    String(value)
      .trim();


  if (!text) {
    return "";
  }


  // Support both:
  // 1.23
  // 1,23

  const normalized =
    text.replace(
      ",",
      "."
    );


  const number =
    Number(
      normalized
    );


  if (
    Number.isFinite(number)
  ) {

    return number;
  }


  // If someone sends text such as
  // "1.3°C", extract the number.

  const extracted =
    extractNumber(
      text
    );


  if (
    extracted !== null
  ) {

    return extracted;
  }


  return text;
}


function jsonResponse(data) {

  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}

function updateTankStatus(
  fermentorID,
  action,
  date,
  pasivationDate
) {

  if (!fermentorID) {
    throw new Error(
      "Missing fermentorID"
    );
  }


  if (action === undefined || action === null) {
    throw new Error(
      "Missing tank action"
    );
  }


  if (!date) {
    throw new Error(
      "Missing date"
    );
  }


  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(String(fermentorID)) +
    "?updateMask.fieldPaths=action" +
    "&updateMask.fieldPaths=date" +
    "&updateMask.fieldPaths=pasivationDate";


  const fields = {

    action: {
      integerValue: String(action)
    },

    date: {
      timestampValue:
        new Date(date).toISOString()
    }

  };


  // Pasivation date is optional
  if (pasivationDate) {

    fields.pasivationDate = {

      timestampValue:
        new Date(
          pasivationDate + "T00:00:00"
        ).toISOString()

    };

  } else {

    fields.pasivationDate = {
      nullValue: null
    };

  }


  const firestoreDocument = {
    fields: fields
  };


  Logger.log(
    "Sending to Firebase: " +
    JSON.stringify(firestoreDocument)
  );


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

        muteHttpExceptions:
          true
      }
    );


  const code =
    response.getResponseCode();

  const body =
    response.getContentText();


  Logger.log(
    "Firebase HTTP status: " +
    code
  );


  Logger.log(
    "Firebase response: " +
    body
  );


  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Firebase update failed: " +
      code +
      " " +
      body
    );
  }


  Logger.log(
    "Updated fermentor: " +
    fermentorID
  );
}