function assignAndRefreshTank(
  fermentorID,
  sheetUrl,
  desiredAction,
  desiredTankStatus
) {

  const fermentorId =
    String(
      fermentorID || ""
    ).trim();


  if (!fermentorId) {
    throw new Error(
      "Missing fermentorID"
    );
  }


  if (!sheetUrl) {
    throw new Error(
      "Missing sheetUrl"
    );
  }


  const action =
    Number(
      desiredAction
    );


  if (
    !Number.isFinite(action)
  ) {
    throw new Error(
      "Invalid desiredAction"
    );
  }


  logToSheet(
    "assignAndRefreshTank - extracting brew from: " +
    sheetUrl
  );


  // ==========================================================
  // READ GOOGLE SHEET
  // ==========================================================

  // extractBrew already exists (brewAssist.gs)
  const brew =
    extractBrew(
      sheetUrl
    );


  if (!brew) {

    throw new Error(
      "Could not read sheet: " +
      sheetUrl
    );

  }


  // ==========================================================
  // GET EXISTING FERMENTOR FROM FIRESTORE
  // ==========================================================

  const existingFermentor =
    getFermentorFromFirestore(
      FIREBASE_PROJECT_ID,
      fermentorId
    );


  if (!existingFermentor) {

    throw new Error(
      "Fermentor not found: " +
      fermentorId
    );

  }


  const existingCurrentData =
    existingFermentor.currentData || {};

  const existingTankNumber = existingFermentor.tankNumber;
  // ==========================================================
  // INCOMING CURRENT DATA
  // ==========================================================

  const incomingCurrentData =
    brew.currentData || {};


  // ==========================================================
  // MERGE CURRENT DATA
  // ==========================================================
  //
  // הנתונים מה-Sheet נכנסים,
  // אבל השדות הבאים מוגנים:
  //
  // kegs
  // crates
  // totalLiters
  // shrinkagePercent
  //
  // אם הם קיימים ב-Firestore,
  // הערך הקיים נשמר.
  // ==========================================================

  const mergedCurrentData = {
    ...incomingCurrentData
  };


  const protectedFields = [
    "kegs",
    "crates",
    "totalLiters",
    "shrinkagePercent"
  ];


  protectedFields.forEach(
    function (fieldName) {

      if (
        Object.prototype.hasOwnProperty.call(
          existingCurrentData,
          fieldName
        )
      ) {

        mergedCurrentData[fieldName] =
          existingCurrentData[fieldName];

      }

    }
  );


  // ==========================================================
  // FERMENTOR DATA
  // ==========================================================

  const fermentor = {

    // IMPORTANT:
    // tankNumber is deliberately NOT touched.
    tankStatus:
      Boolean(
        desiredTankStatus
      ),

    batchNumber:
      brew.batchNumber || null,

    beerStyle:
      brew.beerStyle || null,

    brewDate:
      brew.brewDate || null,

    beerVolume:
      brew.beerVolume || null,

    currentData:
      mergedCurrentData,

    sheetUrl:
      brew.sheetUrl || sheetUrl,

    startingPlato:
      brew.startingPlato || null,

    action:
      action,

    updatedAt:
      new Date()
  };


  // ==========================================================
  // FIRESTORE FIELDS
  // ==========================================================

  const fields =
    toFirestoreFields(
      fermentor
    );
  logToSheet(
    "ASSIGN TANK: UID=" + fermentorId +
    " | Firestore tankNumber=" + existingFermentor.tankNumber +
    " | Sheet tankNumber=" + (brew.tankNumber || "EMPTY") +
    " | tankNumber will NOT be updated"
  );
  delete fields.tankNumber;
  // ==========================================================
  // FIRESTORE UPDATE
  // ==========================================================

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    ) +
    "?updateMask.fieldPaths=tankStatus" +
    "&updateMask.fieldPaths=batchNumber" +
    "&updateMask.fieldPaths=beerStyle" +
    "&updateMask.fieldPaths=brewDate" +
    "&updateMask.fieldPaths=beerVolume" +
    "&updateMask.fieldPaths=currentData" +
    "&updateMask.fieldPaths=sheetUrl" +
    "&updateMask.fieldPaths=startingPlato" +
    "&updateMask.fieldPaths=action" +
    "&updateMask.fieldPaths=updatedAt";


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
          JSON.stringify({
            fields:
              fields
          }),

        muteHttpExceptions:
          true

      }
    );


  // ==========================================================
  // CHECK RESPONSE
  // ==========================================================

  const code =
    response.getResponseCode();


  const body =
    response.getContentText();


  logToSheet(
    "assignAndRefreshTank Firebase status: " +
    code
  );


  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Failed to refresh fermentor " +
      fermentorId +
      ": " +
      code +
      " " +
      body
    );

  }


  // ==========================================================
  // RETURN
  // ==========================================================

  return {

    fermentorID:
      fermentorId,

    batchNumber:
      brew.batchNumber,

    beerStyle:
      brew.beerStyle,

    brewDate:
      brew.brewDate,

    sheetUrl:
      brew.sheetUrl ||
      sheetUrl

  };

}

// Lightweight commit path for the "manual status only" tool. The confirmation
// step already re-read the Sheet. Re-extracting the whole brew again here made
// the final click unnecessarily slow and was the main reason it could exceed
// the browser's 15s request timeout. We still re-read Firestore immediately
// before the PATCH and guard against the batch changing underneath the user.
function applyManualStatusChange(
  fermentorID,
  desiredAction,
  desiredTankStatus,
  expectedBatchNumber,
  expectedFromAction
) {
  const fermentorId = String(fermentorID || "").trim();
  const action = Number(desiredAction);

  if (!fermentorId) throw new Error("Missing fermentorID");
  if (![0, 1, 3, 4, 5].includes(action)) {
    throw new Error("Invalid desiredAction");
  }

  const existing = getFermentorFromFirestore(FIREBASE_PROJECT_ID, fermentorId);
  if (!existing) throw new Error("Fermentor not found: " + fermentorId);

  const expectedBatch = String(expectedBatchNumber == null ? "" : expectedBatchNumber)
    .replace("#", "")
    .trim();
  const currentBatch = String(existing.batchNumber == null ? "" : existing.batchNumber)
    .replace("#", "")
    .trim();

  if (expectedBatch && currentBatch !== expectedBatch) {
    throw new Error(
      "האצווה במיכל השתנתה בזמן האישור (" + currentBatch + "). פתח מחדש את הפעולה."
    );
  }

  const expectedAction = Number(expectedFromAction);
  const currentAction = Number(existing.action);
  if (Number.isFinite(expectedAction) && currentAction !== expectedAction) {
    throw new Error(
      "סטטוס המיכל השתנה בזמן האישור. פתח מחדש את הפעולה."
    );
  }

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(fermentorId) +
    "?updateMask.fieldPaths=action" +
    "&updateMask.fieldPaths=tankStatus" +
    "&updateMask.fieldPaths=updatedAt";

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      fields: {
        action: { integerValue: String(action) },
        tankStatus: { booleanValue: Boolean(desiredTankStatus) },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Failed to update fermentor status " + fermentorId + ": " +
      code + " " + response.getContentText()
    );
  }

  return {
    fermentorID: fermentorId,
    batchNumber: currentBatch || null,
    action: action,
    tankStatus: Boolean(desiredTankStatus)
  };
}
