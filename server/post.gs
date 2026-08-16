
function doGet(e) {
  return ContentService
    .createTextOutput(
      JSON.stringify({
        success: true,
        message: "Fermentor API is running"
      })
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}

function doPost(e) {

  try {

    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No POST data received");
    }


    const data =
      JSON.parse(e.postData.contents);


    Logger.log(
      "Received data: " +
      JSON.stringify(data)
    );


    if (data.action !== "updateTankStatus") {

      throw new Error(
        "Unknown action: " +
        data.action
      );
    }


    updateTankStatus(
      data.fermentorID,
      data.tankAction,
      data.date,
      data.pasivationDate
    );


    return ContentService
      .createTextOutput(
        JSON.stringify({
          success: true,
          fermentorID: data.fermentorID,
          action: data.tankAction,
          date: data.date,
          pasivationDate: data.pasivationDate
        })
      )
      .setMimeType(
        ContentService.MimeType.JSON
      );


  } catch (error) {

    Logger.log(
      "doPost ERROR: " +
      error.stack
    );


    return ContentService
      .createTextOutput(
        JSON.stringify({
          success: false,
          error: error.message
        })
      )
      .setMimeType(
        ContentService.MimeType.JSON
      );
  }
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