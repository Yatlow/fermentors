function testNextBatchService() {

  const e = {

    parameter: {

      action: "CheckBatchAssignment",

      tankID: "9",

      requestedBatch: "1546"

    }

  };


  const response =
    doGet(e);


  Logger.log(
    response.getContent()
  );
}

function testDoPostAddFermentationMeasurement() {

  // ==========================================================
  // TEST DATA
  // ==========================================================

  const payload = {

    action:
      "addFermentationMeasurement",

    sheetUrl:
      "https://docs.google.com/spreadsheets/d/1rUF3AsqGkJng9Z_0OoyJUVpPPtXcDHF3r7W49kOy30A/edit?gid=919947248#gid=919947248",

    temperature:
      55,

    pressure:
      55,

    sugar:
      55,

    pH:
      55,

    carbonation:
      55,

    notes:
      "TEST דרך doPost"

  };


  // ==========================================================
  // SIMULATE HTTP POST EVENT
  // ==========================================================

  const e = {

    postData: {

      contents:
        JSON.stringify(
          payload
        ),

      type:
        "application/json"

    }

  };


  // ==========================================================
  // RUN REAL doPost
  // ==========================================================

  Logger.log(
    "========================================"
  );

  Logger.log(
    "TESTING doPost"
  );

  Logger.log(
    "Payload:"
  );

  Logger.log(
    JSON.stringify(
      payload,
      null,
      2
    )
  );


  const response =
    doPost(e);


  // ==========================================================
  // READ RESPONSE
  // ==========================================================

  const responseText =
    response.getContent();


  Logger.log(
    "========================================"
  );

  Logger.log(
    "doPost RESPONSE:"
  );

  Logger.log(
    responseText
  );

  Logger.log(
    "========================================"
  );


  return responseText;
}