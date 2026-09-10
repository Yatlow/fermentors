function calculateWeeklyStyleAverages() {
  const projectId = FIREBASE_PROJECT_ID;

  Logger.log("========================================");
  Logger.log("START WEEKLY STYLE AVERAGES");

  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(
    twelveMonthsAgo.getFullYear() - 1
  );

  const allBrews =
    getAllBrewsFromFirestore(projectId);

  const METRIC_KEYS = [
    "temp",
    "plato",
    "pH",
    "pressure",
    "carbonation"
  ];

  // style -> day -> metric -> { sum, count }
  const accumulator = {};
  // style -> unique brew IDs
  const batchTracker = {};
  allBrews.forEach(function (brew) {

    const data = brew.data || {};

    const style = String(
      data.beerStyle || ""
    ).trim();

    if (!style) return;


    if (!batchTracker[style]) {
      batchTracker[style] = {};
    }

    batchTracker[style][brew.id] = true;
    // -----------------------------------------
    // BREW DATE
    // -----------------------------------------

    const brewDate =
      parseDateOnly(data.brewDate);

    if (!brewDate) {
      Logger.log(
        "Skipping brew " +
        brew.id +
        " - invalid brewDate"
      );
      return;
    }

    if (brewDate < twelveMonthsAgo) {
      return;
    }

    // -----------------------------------------
    // GET MEASUREMENTS
    // -----------------------------------------

    const measurements =
      getMeasurementsForBrew(
        projectId,
        brew.id
      );

    measurements.forEach(function (measurement) {

      const measurementDate =
        parseDateOnly(
          measurement.date
        );

      if (!measurementDate) {
        return;
      }

      // ---------------------------------------
      // CALCULATE DAY SINCE BREW
      // ---------------------------------------

      const day =
        differenceInDays(
          brewDate,
          measurementDate
        );

      // Ignore measurements before brew
      if (day < 0) {
        return;
      }

      // ---------------------------------------
      // INIT STYLE
      // ---------------------------------------

      if (!accumulator[style]) {
        accumulator[style] = {};
      }

      // ---------------------------------------
      // INIT DAY
      // ---------------------------------------

      if (!accumulator[style][day]) {

        accumulator[style][day] = {};

        METRIC_KEYS.forEach(function (metric) {

          accumulator[style][day][metric] = {
            sum: 0,
            count: 0
          };

        });
      }

      // ---------------------------------------
      // ADD METRICS
      // ---------------------------------------

      METRIC_KEYS.forEach(function (metric) {

        const value =
          measurement[metric];

        if (
          value === null ||
          value === undefined ||
          value === ""
        ) {
          return;
        }

        const number =
          Number(value);

        if (isNaN(number)) {
          return;
        }

        accumulator[style][day][metric].sum +=
          number;

        accumulator[style][day][metric].count +=
          1;

      });

    });

  });

  // =========================================
  // WRITE TO FIRESTORE
  // =========================================

  let stylesUpdated = 0;

  Object.keys(accumulator).forEach(
    function (style) {

      const styleData =
        accumulator[style];

      const days = {};

      let totalSamples = 0;

      Object.keys(styleData).forEach(
        function (day) {

          const dayMetrics =
            styleData[day];

          const averages = {};

          let daySamples = 0;

          METRIC_KEYS.forEach(
            function (metric) {

              const item =
                dayMetrics[metric];

              if (item.count > 0) {

                averages[metric] =
                  Math.round(
                    (
                      item.sum /
                      item.count
                    ) * 100
                  ) / 100;

                daySamples +=
                  item.count;

              } else {

                averages[metric] = null;

              }

            }
          );

          averages.sampleCount =
            daySamples;

          totalSamples +=
            daySamples;

          days[day] =
            averages;
        }
      );

      const batchCount =
        batchTracker[style]
          ? Object.keys(batchTracker[style]).length
          : 0;

      const result = {
        style: style,
        days: days,
        sampleCount: totalSamples,
        batchCount: batchCount,
        updatedAt:
          new Date().toISOString()
      };

      // -------------------------------------
      // WRITE:
      // styleAverages/{style}
      // -------------------------------------

      setFirestoreDocument(
        projectId,
        "styleAverages/" +
        encodeURIComponent(style),
        result
      );

      stylesUpdated++;

      Logger.log(
        "Updated style: " +
        style
      );

    }
  );

  Logger.log(
    "Styles updated: " +
    stylesUpdated
  );

  Logger.log(
    "WEEKLY STYLE AVERAGES FINISHED"
  );

  Logger.log("========================================");
}

// ============================================================
// FIRESTORE REST HELPERS
// ============================================================

function firestoreRequest_(url) {
  const token = ScriptApp.getOAuthToken();

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      Authorization: "Bearer " + token
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(
      "Firestore request failed (" +
      code +
      "): " +
      text
    );
  }

  return JSON.parse(text);
}


// ============================================================
// GET ALL BREWS - WITH PAGINATION
// ============================================================

function getAllBrewsFromFirestore(
  projectId
) {

  if (!projectId) {
    throw new Error(
      "projectId is required"
    );
  }

  const baseUrl =
    "https://firestore.googleapis.com/v1/" +
    "projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/brews";

  const allDocuments = [];

  let pageToken = null;

  do {

    let url =
      baseUrl +
      "?pageSize=300";

    if (pageToken) {

      url +=
        "&pageToken=" +
        encodeURIComponent(
          pageToken
        );

    }

    Logger.log(
      "Reading Firestore collection: brews"
    );

    const result =
      firestoreRequest_(url);

    const documents =
      result.documents || [];

    documents.forEach(
      function (document) {
        allDocuments.push(
          document
        );
      }
    );

    pageToken =
      result.nextPageToken || null;

  } while (pageToken);

  Logger.log(
    "Found " +
    allDocuments.length +
    " brews"
  );

  return allDocuments.map(
    function (document) {

      const name =
        document.name || "";

      const id =
        name.split("/").pop();

      return {
        id: id,

        data:
          firestoreFieldsToObject_(
            document.fields || {}
          )
      };

    }
  );
}



// ============================================================
// GET MEASUREMENTS FOR BREW
// ============================================================

function getMeasurementsForBrew(
  projectId,
  brewId
) {

  if (!projectId) {
    throw new Error(
      "projectId is required"
    );
  }

  if (!brewId) {
    throw new Error(
      "brewId is required"
    );
  }

  const baseUrl =
    "https://firestore.googleapis.com/v1/" +
    "projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/" +
    "brews/" +
    encodeURIComponent(brewId) +
    "/measurements";

  const allDocuments = [];

  let pageToken = null;

  do {

    let url =
      baseUrl +
      "?pageSize=300";

    if (pageToken) {

      url +=
        "&pageToken=" +
        encodeURIComponent(
          pageToken
        );

    }

    const result =
      firestoreRequest_(url);

    const documents =
      result.documents || [];

    documents.forEach(
      function (document) {

        allDocuments.push(
          document
        );

      }
    );

    pageToken =
      result.nextPageToken || null;

  } while (pageToken);

  return allDocuments.map(
    function (document) {

      return firestoreFieldsToObject_(
        document.fields || {}
      );

    }
  );
}



// ============================================================
// FIRESTORE VALUE -> JAVASCRIPT VALUE
// ============================================================

function firestoreValueToJs_(value) {

  if (value === undefined || value === null) {
    return null;
  }

  if (value.stringValue !== undefined) {
    return value.stringValue;
  }

  if (value.integerValue !== undefined) {
    return Number(value.integerValue);
  }

  if (value.doubleValue !== undefined) {
    return Number(value.doubleValue);
  }

  if (value.booleanValue !== undefined) {
    return value.booleanValue;
  }

  if (value.timestampValue !== undefined) {
    return value.timestampValue;
  }

  if (value.nullValue !== undefined) {
    return null;
  }

  if (value.referenceValue !== undefined) {
    return value.referenceValue;
  }

  if (value.arrayValue !== undefined) {

    return (
      value.arrayValue.values || []
    ).map(function (item) {
      return firestoreValueToJs_(item);
    });

  }

  if (value.mapValue !== undefined) {

    return firestoreFieldsToObject_(
      value.mapValue.fields || {}
    );

  }

  return null;
}


// ============================================================
// FIRESTORE FIELDS -> JAVASCRIPT OBJECT
// ============================================================

function firestoreFieldsToObject_(
  fields
) {

  const result = {};

  Object.keys(fields).forEach(
    function (key) {

      result[key] =
        firestoreValueToJs_(
          fields[key]
        );

    }
  );

  return result;
}


function parseDateOnly(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  // -----------------------------------------
  // Firestore timestamp / Date
  // -----------------------------------------

  if (value instanceof Date) {

    return new Date(
      value.getFullYear(),
      value.getMonth(),
      value.getDate()
    );

  }

  const str =
    String(value).trim();

  // -----------------------------------------
  // dd/mm/yyyy
  // dd/mm/yy
  // -----------------------------------------

  let match =
    str.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
    );

  if (match) {

    const day =
      Number(match[1]);

    const month =
      Number(match[2]);

    let year =
      Number(match[3]);

    if (year < 100) {
      year += 2000;
    }

    return new Date(
      year,
      month - 1,
      day
    );
  }

  // -----------------------------------------
  // yyyy-mm-dd
  // -----------------------------------------

  match =
    str.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})$/
    );

  if (match) {

    const year =
      Number(match[1]);

    const month =
      Number(match[2]);

    const day =
      Number(match[3]);

    return new Date(
      year,
      month - 1,
      day
    );
  }

  return null;
}



function differenceInDays(
  startDate,
  endDate
) {

  const start = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate()
  );

  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate()
  );

  const milliseconds =
    end.getTime() -
    start.getTime();

  return Math.round(
    milliseconds /
    (1000 * 60 * 60 * 24)
  );
}


// ============================================================
// WRITE FIRESTORE DOCUMENT
// ============================================================

function setFirestoreDocument(
  projectId,
  documentPath,
  data
) {

  if (!projectId) {
    throw new Error(
      "projectId is required"
    );
  }

  if (!documentPath) {
    throw new Error(
      "documentPath is required"
    );
  }

  const url =
    "https://firestore.googleapis.com/v1/" +
    "projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/" +
    documentPath;

  const firestoreFields =
    jsObjectToFirestoreFields_(data);

  const payload = {
    fields: firestoreFields
  };

  const token =
    ScriptApp.getOAuthToken();

  const response =
    UrlFetchApp.fetch(url, {
      method: "patch",

      contentType:
        "application/json",

      headers: {
        Authorization:
          "Bearer " + token
      },

      payload:
        JSON.stringify(payload),

      muteHttpExceptions: true
    });

  const code =
    response.getResponseCode();

  const text =
    response.getContentText();

  if (code < 200 || code >= 300) {

    throw new Error(
      "Firestore write failed (" +
      code +
      "): " +
      text
    );
  }

  Logger.log(
    "Firestore document written: " +
    documentPath
  );

  return JSON.parse(text);
}


// ============================================================
// JAVASCRIPT OBJECT -> FIRESTORE FIELDS
// ============================================================

function jsObjectToFirestoreFields_(
  object
) {

  const fields = {};

  Object.keys(object || {}).forEach(
    function (key) {

      fields[key] =
        jsValueToFirestoreValue_(
          object[key]
        );

    }
  );

  return fields;
}


// ============================================================
// JAVASCRIPT VALUE -> FIRESTORE VALUE
// ============================================================

function jsValueToFirestoreValue_(
  value
) {

  if (value === null || value === undefined) {

    return {
      nullValue: null
    };

  }

  if (typeof value === "string") {

    return {
      stringValue: value
    };

  }

  if (typeof value === "boolean") {

    return {
      booleanValue: value
    };

  }

  if (typeof value === "number") {

    if (Number.isInteger(value)) {

      return {
        integerValue: String(value)
      };

    }

    return {
      doubleValue: value
    };

  }

  if (value instanceof Date) {

    return {
      timestampValue:
        value.toISOString()
    };

  }

  if (Array.isArray(value)) {

    return {
      arrayValue: {
        values: value.map(
          function (item) {
            return jsValueToFirestoreValue_(
              item
            );
          }
        )
      }
    };

  }

  if (typeof value === "object") {

    return {
      mapValue: {
        fields:
          jsObjectToFirestoreFields_(
            value
          )
      }
    };

  }

  throw new Error(
    "Unsupported Firestore value type: " +
    typeof value
  );
}
