// ============================================================
// CONFIGURATION
// ============================================================

const FIREBASE_PROJECT_ID =
  "fermenter-dashboard-bada3";

const BREW_FOLDER_ID =
  "0B6DbCIATIM92fm1KQkpVeTR3dXk1ZVRPOUttUVJGelMzcl9nUTR6SzM3ZEE3WjVvc0RvSVk";


// ============================================================
// MAIN EXTRACTION
// ============================================================

function extractBrew(spreadSheetId) {

  if (!spreadSheetId) {
    throw new Error(
      "No Spreadsheet ID or URL was provided."
    );
  }

  const spreadsheetId =
    extractSpreadsheetId(spreadSheetId);

  const ss =
    SpreadsheetApp.openById(spreadsheetId);

  const sheet =
    ss.getSheets()[0];

  const values =
    sheet
      .getDataRange()
      .getDisplayValues();

  const brew = {

    batchNumber: null,
    beerStyle: null,
    brewDate: null,
    tankNumber: null,

    sheetUrl:
      ss.getUrl(),

    tankStatus: null,
    beerVolume: null,
    startingPlato: null,
    pasivationDate: null,

    currentData: {

      date: null,
      temp: null,
      plato: null,
      carbonation: null,
      pH: null,
      notes: ""
    }
  };


  // ==========================================================
  // BREW HEADER
  // ==========================================================

  const batchHeader =
    values[0] || [];

  brew.batchNumber =
    String(
      batchHeader[5] || ""
    )
      .replace("#", "")
      .trim() || null;

  brew.beerStyle =
    String(
      batchHeader[1] || ""
    )
      .trim() || null;

  brew.tankNumber =
    String(
      batchHeader[3] || ""
    )
      .trim() || null;

  brew.brewDate =
    String(
      batchHeader[7] || ""
    )
      .trim() || null;


  // ==========================================================
  // FERMENTATION HEADER
  // ==========================================================

  const fermentationHeader =
    findRowContaining(
      values,
      "דף תסיסה"
    );

  if (
    fermentationHeader !== -1
  ) {

    for (
      let r = fermentationHeader;
      r < Math.min(
        fermentationHeader + 6,
        values.length
      );
      r++
    ) {

      for (
        let c = 0;
        c < values[r].length;
        c++
      ) {

        const cell =
          String(
            values[r][c] || ""
          ).trim();


        // ------------------------------------------------------
        // BATCH
        // ------------------------------------------------------

        if (
          cell === "אצווה:"
        ) {

          const batch =
            String(
              values[r][c + 1] || ""
            )
              .replace("#", "")
              .trim();

          if (batch) {

            brew.batchNumber =
              brew.batchNumber
                ? brew.batchNumber
                : batch;
          }
        }


        // ------------------------------------------------------
        // BEER STYLE
        // ------------------------------------------------------

        if (
          cell === "סוג:"
        ) {

          const beerStyle =
            String(
              values[r][c + 1] || ""
            ).trim();

          brew.beerStyle =
            brew.beerStyle
              ? brew.beerStyle
              : beerStyle || null;
        }


        // ------------------------------------------------------
        // TANK NUMBER
        // ------------------------------------------------------

        if (
          cell === "מספר מיכל:"
        ) {

          const tankNumber =
            String(
              values[r][c + 1] || ""
            ).trim();

          brew.tankNumber =
            brew.tankNumber
              ? brew.tankNumber
              : tankNumber || null;
        }
      }
    }
  }


  // ==========================================================
  // BREW DATE
  // ==========================================================

  const brewDayRow =
    findRowContaining(
      values,
      "יום בישול"
    );

  if (
    brewDayRow !== -1
  ) {

    const col =
      findColumnContaining(
        values[brewDayRow],
        "יום בישול"
      );

    if (
      col !== -1
    ) {

      const brewDate =
        String(
          values[brewDayRow][col + 1] || ""
        ).trim();

      brew.brewDate =
        brew.brewDate
          ? brew.brewDate
          : brewDate || null;
    }
  }


  // ==========================================================
  // VOLUME
  // ==========================================================

  const volumeLocation =
    findCell(
      values,
      "נפח:"
    );

  if (
    volumeLocation
  ) {

    const volumeText =
      values[
        volumeLocation.row
      ][
        volumeLocation.col + 1
      ];

    brew.beerVolume =
      extractNumber(
        volumeText
      );
  }


  // ==========================================================
  // TANK STATUS
  // ==========================================================

  const statusLocation =
    findCell(
      values,
      "ריק?:"
    );

  if (
    statusLocation
  ) {

    const statusVal =
      values[
        statusLocation.row
      ][
        statusLocation.col + 1
      ];

    brew.tankStatus =
      String(
        statusVal || ""
      ).trim() || null;
  }


  // ==========================================================
  // STARTING PLATO
  // ==========================================================

  const startingPlatoLocation =
    findCell(
      values,
      "סוכר תחילי"
    );

  if (
    startingPlatoLocation
  ) {

    const startingPlatoValue =
      values[
        startingPlatoLocation.row
      ][
        startingPlatoLocation.col + 1
      ];

    const startingPlatoText =
      String(
        startingPlatoValue || ""
      ).trim();

    if (
      startingPlatoText
    ) {

      brew.startingPlato =
        extractNumber(
          startingPlatoText
        );

    } else {

      for (
        let z = 1;
        z <= startingPlatoLocation.row;
        z++
      ) {

        const row =
          startingPlatoLocation.row - z;

        for (
          let c = 0;
          c < values[row].length;
          c++
        ) {

          const cell =
            String(
              values[row][c] || ""
            ).trim();

          if (
            cell === "תחילת תסיסה"
          ) {

            const possibleValue =
              values[row][c + 1];

            const number =
              extractNumber(
                possibleValue
              );

            if (
              number !== null
            ) {

              brew.startingPlato =
                number;
            }

            break;
          }
        }

        if (
          brew.startingPlato !== null
        ) {

          break;
        }
      }
    }
  }


  // ==========================================================
  // CURRENT DATA
  // ==========================================================

  brew.currentData =
    findLatestAvailableMeasurements(
      values
    );


  Logger.log(
    JSON.stringify(
      brew,
      null,
      2
    )
  );

  return brew;
}


// ============================================================
// EXTRACT SPREADSHEET ID
// ============================================================

function extractSpreadsheetId(
  value
) {

  if (!value) {

    throw new Error(
      "No Google Sheet URL or ID provided."
    );
  }

  const text =
    String(value).trim();

  if (
    !text.includes("/")
  ) {

    return text;
  }

  const match =
    text.match(
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/
    );

  if (!match) {

    throw new Error(
      "Could not extract Spreadsheet ID from: " +
      text
    );
  }

  return match[1];
}


// ============================================================
// FIND ROW
// ============================================================

function findRowContaining(
  values,
  text
) {

  for (
    let r = 0;
    r < values.length;
    r++
  ) {

    for (
      let c = 0;
      c < values[r].length;
      c++
    ) {

      if (
        String(
          values[r][c] || ""
        )
          .trim()
          .includes(text)
      ) {

        return r;
      }
    }
  }

  return -1;
}


// ============================================================
// FIND COLUMN
// ============================================================

function findColumnContaining(
  row,
  text
) {

  for (
    let c = 0;
    c < row.length;
    c++
  ) {

    if (
      String(
        row[c] || ""
      )
        .trim()
        .includes(text)
    ) {

      return c;
    }
  }

  return -1;
}


// ============================================================
// FIND EXACT CELL
// ============================================================

function findCell(
  values,
  text
) {

  for (
    let r = 0;
    r < values.length;
    r++
  ) {

    for (
      let c = 0;
      c < values[r].length;
      c++
    ) {

      if (
        String(
          values[r][c] || ""
        )
          .trim() === text
      ) {

        return {
          row: r,
          col: c
        };
      }
    }
  }

  return null;
}


// ============================================================
// EXTRACT NUMBER
// ============================================================

function extractNumber(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }

  const match =
    String(value).match(
      /-?\d+(?:[.,]\d+)?/
    );

  if (!match) {

    return null;
  }

  return Number(
    match[0]
      .replace(",", ".")
  );
}


// ============================================================
// CURRENT FERMENTATION DATA
// ============================================================

function findLatestAvailableMeasurements(
  values
) {

  const result = {

    date: null,
    temp: null,
    plato: null,
    carbonation: null,
    pH: null,
    notes: null
  };

  const latest = {

    temp: null,
    plato: null,
    carbonation: null,
    pH: null,
    notes: null
  };

  const headerRow =
    findRowContaining(
      values,
      "טמפרטורה"
    );

  if (
    headerRow === -1
  ) {

    return result;
  }


  for (
    let r = headerRow + 1;
    r < values.length;
    r++
  ) {

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


    // --------------------------------------------------------
    // TEMP
    // --------------------------------------------------------

    if (
      values[r][3]
    ) {

      const temp =
        extractNumber(
          values[r][3]
        );

      if (
        temp !== null &&
        (
          !latest.temp ||
          date > latest.temp.date
        )
      ) {

        result.temp =
          temp;

        latest.temp = {
          date: date,
          dateText: dateText
        };
      }
    }


    // --------------------------------------------------------
    // PLATO
    // --------------------------------------------------------

    if (
      values[r][2]
    ) {

      const plato =
        extractNumber(
          values[r][2]
        );

      if (
        plato !== null &&
        (
          !latest.plato ||
          date > latest.plato.date
        )
      ) {

        result.plato =
          plato;

        latest.plato = {
          date: date,
          dateText: dateText
        };
      }
    }


    // --------------------------------------------------------
    // pH
    // --------------------------------------------------------

    if (
      values[r][5]
    ) {

      const pH =
        extractNumber(
          values[r][5]
        );

      if (
        pH !== null &&
        (
          !latest.pH ||
          date > latest.pH.date
        )
      ) {

        result.pH =
          pH;

        latest.pH = {
          date: date,
          dateText: dateText
        };
      }
    }


    // --------------------------------------------------------
    // CARBONATION
    // --------------------------------------------------------

    if (
      values[r][6]
    ) {

      const carbonation =
        extractNumber(
          values[r][6]
        );

      if (
        carbonation !== null &&
        (
          !latest.carbonation ||
          date > latest.carbonation.date
        )
      ) {

        result.carbonation =
          carbonation;

        latest.carbonation = {
          date: date,
          dateText: dateText
        };
      }
    }


    // --------------------------------------------------------
    // NOTES
    // --------------------------------------------------------

    if (
      values[r][7]
    ) {

      const notes =
        String(
          values[r][7]
        ).trim();

      if (
        notes &&
        (
          !latest.notes ||
          date > latest.notes.date
        )
      ) {

        result.notes =
          notes;

        latest.notes = {
          date: date,
          dateText: dateText
        };
      }
    }
  }


  // ==========================================================
  // CURRENT DATE
  // ==========================================================

  const dates =
    Object.values(latest)
      .filter(
        item =>
          item !== null
      )
      .map(
        item =>
          item.date
      );

  if (
    dates.length > 0
  ) {

    const newestDate =
      new Date(
        Math.max(
          ...dates.map(
            date =>
              date.getTime()
          )
        )
      );

    const matchingMeasurement =
      Object.values(latest)
        .find(
          item =>
            item &&
            item.date.getTime() ===
            newestDate.getTime()
        );

    if (
      matchingMeasurement
    ) {

      result.date =
        matchingMeasurement.dateText;
    }
  }

  return result;
}


// ============================================================
// PARSE ISRAELI DATE
// ============================================================

function parseIsraeliDate(
  value
) {

  if (!value) {
    return null;
  }

  const match =
    String(value).match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
    );

  if (!match) {
    return null;
  }

  const day =
    Number(match[1]);

  const month =
    Number(match[2]) - 1;

  let year =
    Number(match[3]);

  if (
    year < 100
  ) {

    year += 2000;
  }

  return new Date(
    year,
    month,
    day
  );
}


// ============================================================
// FIRESTORE CONVERSION
// ============================================================

function toFirestoreFields(
  object
) {

  const fields = {};

  for (
    const key in object
  ) {

    fields[key] =
      toFirestoreValue(
        object[key]
      );
  }

  return fields;
}


function toFirestoreValue(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return {
      nullValue: null
    };
  }

  if (
    typeof value === "string"
  ) {

    return {
      stringValue: value
    };
  }

  if (
    typeof value === "number"
  ) {

    if (
      Number.isInteger(value)
    ) {

      return {
        integerValue:
          String(value)
      };

    } else {

      return {
        doubleValue:
          value
      };
    }
  }

  if (
    typeof value === "boolean"
  ) {

    return {
      booleanValue:
        value
    };
  }

  if (
    value instanceof Date
  ) {

    return {
      timestampValue:
        value.toISOString()
    };
  }

  if (
    typeof value === "object"
  ) {

    return {

      mapValue: {

        fields:
          toFirestoreFields(
            value
          )
      }
    };
  }

  throw new Error(
    "Unsupported value type: " +
    typeof value
  );
}


// ============================================================
// FIRESTORE VALUE NORMALIZATION
// ============================================================

function normalizeFirestoreValue(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "stringValue"
    )
  ) {

    return value.stringValue;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "integerValue"
    )
  ) {

    return Number(
      value.integerValue
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "doubleValue"
    )
  ) {

    return Number(
      value.doubleValue
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "booleanValue"
    )
  ) {

    return value.booleanValue;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "nullValue"
    )
  ) {

    return null;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "timestampValue"
    )
  ) {

    return value.timestampValue;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "mapValue"
    )
  ) {

    const fields =
      value.mapValue.fields || {};

    const result = {};

    for (
      const key in fields
    ) {

      result[key] =
        normalizeFirestoreValue(
          fields[key]
        );
    }

    return result;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      value,
      "arrayValue"
    )
  ) {

    const values =
      value.arrayValue.values || [];

    return values.map(
      item =>
        normalizeFirestoreValue(
          item
        )
    );
  }

  return value;
}


// ============================================================
// FIRESTORE GET DOCUMENT
// ============================================================

function getFirestoreDocument(
  url
) {

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
    code === 404
  ) {

    return null;
  }

  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Firestore GET failed: " +
      code +
      " " +
      response.getContentText()
    );
  }

  return JSON.parse(
    response.getContentText()
  );
}


// ============================================================
// COMPARE OBJECTS
// ============================================================

function objectsEqual(
  a,
  b
) {

  return JSON.stringify(
    normalizeForComparison(a)
  ) ===
  JSON.stringify(
    normalizeForComparison(b)
  );
}


function normalizeForComparison(
  value
) {

  if (
    value === undefined
  ) {

    return null;
  }

  if (
    value === null
  ) {

    return null;
  }

  if (
    value instanceof Date
  ) {

    return value.toISOString();
  }

  if (
    typeof value === "object"
  ) {

    if (
      Array.isArray(value)
    ) {

      return value.map(
        item =>
          normalizeForComparison(
            item
          )
      );
    }

    const result = {};

    Object.keys(value)
      .sort()
      .forEach(
        key => {

          result[key] =
            normalizeForComparison(
              value[key]
            );
        }
      );

    return result;
  }

  return value;
}


// ============================================================
// CREATE MEASUREMENT ID
// ============================================================

function createMeasurementId(
  date,
  time
) {

  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getDate()
    ).padStart(2, "0");

  let cleanTime =
    String(
      time || ""
    )
      .replace(/:/g, "")
      .replace(
        /\s/g,
        ""
      );

  if (!cleanTime) {
    cleanTime = "0000";
  }

  return (
    year +
    "-" +
    month +
    "-" +
    day +
    "_" +
    cleanTime
  );
}


// ============================================================
// UPLOAD HISTORICAL MEASUREMENTS
// ============================================================

function uploadHistoricalMeasurements(
  projectId,
  batchId,
  sheetUrl
) {

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
      "No fermentation table found."
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


    if (
      !values[r][2] &&
      !values[r][3] &&
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
      projectId +
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


    let shouldWrite = true;


    if (
      existing &&
      existing.fields
    ) {

      const existingMeasurement = {};


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

        shouldWrite = false;
      }
    }


    // ========================================================
    // SKIP UNCHANGED
    // ========================================================

    if (
      !shouldWrite
    ) {

      skippedCount++;

      Logger.log(
        "SKIPPED unchanged measurement: " +
        measurementId
      );

      continue;
    }


    // ========================================================
    // WRITE
    // ========================================================

    const document = {

      fields:
        toFirestoreFields(
          measurement
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
              document
            ),

          muteHttpExceptions:
            true
        }
      );


    const code =
      response.getResponseCode();


    if (
      code >= 200 &&
      code < 300
    ) {

      savedCount++;

      Logger.log(
        "SAVED measurement: " +
        measurementId
      );

    } else {

      throw new Error(
        "Measurement " +
        measurementId +
        " failed: " +
        code +
        " " +
        response.getContentText()
      );
    }
  }


  Logger.log(
    "Historical measurements saved: " +
    savedCount
  );

  Logger.log(
    "Historical measurements skipped: " +
    skippedCount
  );
}


// ============================================================
// UPLOAD FERMENTOR
// ============================================================

function uploadFermentorToFirebase(
  projectId,
  brew
) {

  if (!brew) {

    throw new Error(
      "No brew data provided."
    );
  }

  if (!brew.tankNumber) {

    throw new Error(
      "Cannot upload fermentor: no tank number found."
    );
  }


  const fermentorId =
    String(
      brew.tankNumber
    ).trim();


  const fermentor = {

    tankNumber:
      fermentorId,

    tankStatus:
      brew.tankStatus === "TRUE",

    batchNumber:
      brew.batchNumber || null,

    beerStyle:
      brew.beerStyle || null,

    brewDate:
      brew.brewDate || null,

    beerVolume:
      brew.beerVolume || null,

    currentData:
      brew.currentData || null,

    sheetUrl:
      brew.sheetUrl || null,

    uid:
      fermentorId,

    startingPlato:
      brew.startingPlato || null
  };


  // ==========================================================
  // FERMENTOR URL
  // ==========================================================

  const baseUrl =
    "https://firestore.googleapis.com/v1/projects/" +
    projectId +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(
      fermentorId
    );


  // ==========================================================
  // CHECK EXISTING FERMENTOR
  // ==========================================================

  const existing =
    getFirestoreDocument(
      baseUrl
    );


  let existingData = null;


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
  // REMOVE updatedAt FROM COMPARISON
  // ==========================================================

  let existingComparable =
    existingData
      ? JSON.parse(
          JSON.stringify(
            existingData
          )
        )
      : null;


  if (
    existingComparable
  ) {

    delete existingComparable.updatedAt;
  }


  // ==========================================================
  // COMPARE
  // ==========================================================

  if (
    existingComparable &&
    objectsEqual(
      fermentor,
      existingComparable
    )
  ) {

    Logger.log(
      "SKIPPED unchanged fermentor: " +
      fermentorId
    );

    return;
  }


  // ==========================================================
  // SOMETHING CHANGED
  // ==========================================================

  fermentor.updatedAt =
    new Date();


  const fields =
    toFirestoreFields(
      fermentor
    );


  // ==========================================================
  // PASIVATION DATE
  // ==========================================================

  let includePasivationDate =
    false;


  if (
    brew.pasivationDate !== null &&
    brew.pasivationDate !== undefined &&
    String(
      brew.pasivationDate
    ).trim() !== ""
  ) {

    fields.pasivationDate =
      toFirestoreValue(
        brew.pasivationDate
      );

    includePasivationDate =
      true;
  }


  // ==========================================================
  // UPDATE MASK
  // ==========================================================

  let url =
    baseUrl +

    "?updateMask.fieldPaths=tankNumber" +

    "&updateMask.fieldPaths=tankStatus" +

    "&updateMask.fieldPaths=batchNumber" +

    "&updateMask.fieldPaths=beerStyle" +

    "&updateMask.fieldPaths=brewDate" +

    "&updateMask.fieldPaths=beerVolume" +

    "&updateMask.fieldPaths=currentData" +

    "&updateMask.fieldPaths=sheetUrl" +

    "&updateMask.fieldPaths=uid" +

    "&updateMask.fieldPaths=startingPlato" +

    "&updateMask.fieldPaths=updatedAt";


  if (
    includePasivationDate
  ) {

    url +=
      "&updateMask.fieldPaths=pasivationDate";
  }


  // ==========================================================
  // WRITE
  // ==========================================================

  const firestoreDocument = {

    fields:
      fields
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

        muteHttpExceptions:
          true
      }
    );


  const code =
    response.getResponseCode();


  const body =
    response.getContentText();


  Logger.log(
    "Fermentor Firebase HTTP status: " +
    code
  );


  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Fermentor upload failed: " +
      code +
      " " +
      body
    );
  }


  Logger.log(
    "UPDATED fermentor: " +
    fermentorId
  );
}


// ============================================================
// UPLOAD BREW
// ============================================================

function uploadBrewToFirebase(
  sheetUrl
) {

  if (!sheetUrl) {

    throw new Error(
      "Please provide a Google Sheet URL or ID."
    );
  }


  // ==========================================================
  // EXTRACT
  // ==========================================================

  const brew =
    extractBrew(
      sheetUrl
    );


  // ==========================================================
  // VALIDATE
  // ==========================================================

  if (
    !brew.batchNumber
  ) {

    throw new Error(
      "No batch number found."
    );
  }


  const documentId =
    String(
      brew.batchNumber
    ).trim();


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
  // REMOVE uid / timestamps FROM COMPARISON
  // ==========================================================

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


  let existingData = null;


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


    if (
      objectsEqual(
        brewForComparison,
        existingForComparison
      )
    ) {

      Logger.log(
        "SKIPPED unchanged brew: " +
        documentId
      );

    } else {

      // ------------------------------------------------------
      // BREW CHANGED
      // ------------------------------------------------------

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
          "Firebase upload failed: " +
          code +
          " " +
          response.getContentText()
        );
      }


      Logger.log(
        "UPDATED brew: " +
        documentId
      );
    }

  } else {

    // --------------------------------------------------------
    // NEW BREW
    // --------------------------------------------------------

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
        "Firebase upload failed: " +
        code +
        " " +
        response.getContentText()
      );
    }


    Logger.log(
      "CREATED brew: " +
      documentId
    );
  }


  // ==========================================================
  // HISTORICAL DATA
  // ==========================================================

  uploadHistoricalMeasurements(
    FIREBASE_PROJECT_ID,
    documentId,
    sheetUrl
  );


  // ==========================================================
  // FERMENTOR
  // ==========================================================

  uploadFermentorToFirebase(
    FIREBASE_PROJECT_ID,
    brew
  );


  // ==========================================================
  // FINISHED
  // ==========================================================

  Logger.log(
    "Finished uploading brew: " +
    documentId
  );
}


// ============================================================
// PARSE BATCH NUMBER
// ============================================================

function parseBatchNumber(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }

  const text =
    String(value)
      .replace("#", "")
      .trim();

  if (!text) {

    return null;
  }

  const number =
    Number(text);

  if (
    !Number.isFinite(number)
  ) {

    return null;
  }

  return number;
}


// ============================================================
// FIND NEXT BREW FOR TANK
// ============================================================

function findNextBrewForTank(
  tankNumber,
  currentBatchNumber
) {

  if (!tankNumber) {

    throw new Error(
      "Missing tank number."
    );
  }

  const currentBatch =
    parseBatchNumber(
      currentBatchNumber
    );

  if (
    currentBatch === null
  ) {

    throw new Error(
      "Invalid current batch number: " +
      currentBatchNumber
    );
  }


  Logger.log(
    "========================================"
  );

  Logger.log(
    "Searching next brew"
  );

  Logger.log(
    "Tank: " +
    tankNumber
  );

  Logger.log(
    "Current batch: " +
    currentBatch
  );


  const folder =
    DriveApp.getFolderById(
      BREW_FOLDER_ID
    );


  const files =
    folder.getFilesByType(
      MimeType.GOOGLE_SHEETS
    );


  let bestBrew = null;

  let checkedFiles = 0;

  let validBrews = 0;

  let tankMatches = 0;


  while (
    files.hasNext()
  ) {

    const file =
      files.next();

    checkedFiles++;


    try {

      const brew =
        extractBrew(
          file.getId()
        );


      if (!brew) {
        continue;
      }


      validBrews++;


      // ------------------------------------------------------
      // TANK MATCH
      // ------------------------------------------------------

      if (
        String(
          brew.tankNumber
        ).trim() !==
        String(
          tankNumber
        ).trim()
      ) {

        continue;
      }


      tankMatches++;


      // ------------------------------------------------------
      // BATCH
      // ------------------------------------------------------

      const batch =
        parseBatchNumber(
          brew.batchNumber
        );


      if (
        batch === null
      ) {

        continue;
      }


      // ------------------------------------------------------
      // FUTURE ONLY
      // ------------------------------------------------------

      if (
        batch <= currentBatch
      ) {

        continue;
      }


      // ------------------------------------------------------
      // CLOSEST FUTURE BATCH
      // ------------------------------------------------------

      if (
        !bestBrew ||
        batch <
        parseBatchNumber(
          bestBrew.batchNumber
        )
      ) {

        bestBrew = {

          found: true,

          batchNumber:
            brew.batchNumber,

          tankNumber:
            brew.tankNumber,

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
            file.getName()
        };
      }

    } catch (
      error
    ) {

      Logger.log(
        "Skipping file " +
        file.getName() +
        ": " +
        error.message
      );
    }
  }


  Logger.log(
    "========================================"
  );

  Logger.log(
    "Files checked: " +
    checkedFiles
  );

  Logger.log(
    "Valid brews: " +
    validBrews
  );

  Logger.log(
    "Tank matches: " +
    tankMatches
  );


  if (
    bestBrew
  ) {

    Logger.log(
      "NEXT BREW FOUND:"
    );

    Logger.log(
      JSON.stringify(
        bestBrew,
        null,
        2
      )
    );

  } else {

    Logger.log(
      "NO FUTURE BREW FOUND."
    );
  }


  Logger.log(
    "========================================"
  );


  return bestBrew;
}


// ============================================================
// TEST NEXT BREW
// ============================================================

function testFindNextBrewForTank() {

  const tankNumber =
    "12";

  const currentBatchNumber =
    "1567";

  const result =
    findNextBrewForTank(
      tankNumber,
      currentBatchNumber
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
// MANUAL FIREBASE TEST
// ============================================================

function testFirebaseUpload() {

  uploadBrewToFirebase(
    "https://docs.google.com/spreadsheets/d/140dqVSyz4UCVFFgxVTVGgQoBlZYGqYF9jaybWr6lulk/edit?usp=drive_link"
  );
}