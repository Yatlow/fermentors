const WEEKLY_STYLE_MODEL_LAST_RUN_KEY = "weekly_style_models_last_run_v2";
const WEEKLY_STYLE_MODEL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function calculateWeeklyStyleAverages(force) {
  const runStartedAt = Date.now();
  const props = PropertiesService.getScriptProperties();
  const lastRunAt = Number(props.getProperty(WEEKLY_STYLE_MODEL_LAST_RUN_KEY) || 0);

  if (!force && lastRunAt && runStartedAt - lastRunAt < WEEKLY_STYLE_MODEL_INTERVAL_MS) {
    return {
      skipped: true,
      lastRunAt: new Date(lastRunAt).toISOString()
    };
  }

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
  // normalized style -> historical pressure correction outcomes
  const pressureSamplesByStyle = {};
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

    const pressureStyle = normalizePressureModelStyle_(style);
    if (!pressureSamplesByStyle[pressureStyle]) {
      pressureSamplesByStyle[pressureStyle] = [];
    }
    Array.prototype.push.apply(
      pressureSamplesByStyle[pressureStyle],
      buildPressureResponseSamplesForBrew_(measurements, brewDate, brew.id)
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

  let pressureModelsUpdated = 0;
  Object.keys(pressureSamplesByStyle).forEach(function (styleKey) {
    const samples = pressureSamplesByStyle[styleKey]
      .filter(function (sample) { return sample && sample.success === true; })
      .slice(-120);

    if (samples.length === 0) return;

    writeMergedPressureResponseModel_(
      projectId,
      styleKey,
      samples
    );
    pressureModelsUpdated++;
  });

  Logger.log("Pressure response models updated: " + pressureModelsUpdated);

  Logger.log(
    "WEEKLY STYLE AVERAGES FINISHED"
  );

  Logger.log("========================================");

  props.setProperty(WEEKLY_STYLE_MODEL_LAST_RUN_KEY, String(Date.now()));
  return {
    skipped: false,
    stylesUpdated: stylesUpdated,
    pressureModelsUpdated: pressureModelsUpdated
  };
}

function pressureSampleKey_(sample) {
  return [
    String(sample && sample.batchId || ""),
    String(sample && sample.eventDate || ""),
    String(sample && sample.targetPressure || "")
  ].join("|");
}

function mergePressureSamples_(existingSamples, incomingSamples, maxSamples) {
  const merged = new Map();

  (existingSamples || []).forEach(function (sample) {
    if (!sample) return;
    merged.set(pressureSampleKey_(sample), sample);
  });
  (incomingSamples || []).forEach(function (sample) {
    if (!sample || sample.success !== true) return;
    merged.set(pressureSampleKey_(sample), sample);
  });

  return Array.from(merged.values())
    .sort(function (a, b) {
      const aDate = parseDateOnly(a && a.eventDate);
      const bDate = parseDateOnly(b && b.eventDate);
      const aTime = aDate ? aDate.getTime() : 0;
      const bTime = bDate ? bDate.getTime() : 0;
      return aTime - bTime;
    })
    .slice(-Math.max(20, Number(maxSamples) || 600));
}

function getPressureResponseModel_(projectId, styleKey) {
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/pressureResponseModels/" +
    encodeURIComponent(styleKey);

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(
      "Pressure model read failed (" + response.getResponseCode() + "): " +
      response.getContentText()
    );
  }

  const parsed = JSON.parse(response.getContentText() || "{}");
  return firestoreFieldsToObject_(parsed.fields || {});
}

function writeMergedPressureResponseModel_(projectId, styleKey, incomingSamples) {
  const existing = getPressureResponseModel_(projectId, styleKey);
  const samples = mergePressureSamples_(
    existing && Array.isArray(existing.samples) ? existing.samples : [],
    incomingSamples,
    600
  );

  if (samples.length === 0) return null;

  return setFirestoreDocument(
    projectId,
    "pressureResponseModels/" + encodeURIComponent(styleKey),
    {
      style: styleKey,
      samples: samples,
      sampleCount: samples.length,
      updatedAt: new Date().toISOString()
    }
  );
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



function normalizePressureModelStyle_(style) {
  return String(style || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] || "other";
}

function pressureModelNumber_(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function pressureTargetFromNote_(note) {
  const matches = Array.from(
    String(note || "").matchAll(
      /(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל\s*:?-?\s*(\d+(?:[.,]\d+)?)/gi
    )
  );
  const match = matches.length ? matches[matches.length - 1] : null;
  return match ? pressureModelNumber_(match[1]) : null;
}

function measurementSortTime_(measurement) {
  const date = parseDateOnly(measurement && measurement.date);
  if (!date) return 0;
  const timeMatch = String(measurement.time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
  }
  return date.getTime();
}

function pressureHistoryContext_(rows, endIndexExclusive, referenceDate) {
  const values = [];
  for (let i = 0; i < endIndexExclusive; i++) {
    const row = rows[i];
    const pressure = pressureModelNumber_(row && row.pressure);
    const date = parseDateOnly(row && row.date);
    if (pressure === null || !date) continue;
    const daysAgo = differenceInDays(date, referenceDate);
    if (daysAgo < 0) continue;
    values.push({ pressure: pressure, daysAgo: daysAgo });
  }

  function mean(filtered) {
    if (!filtered.length) return null;
    return filtered.reduce(function (sum, item) {
      return sum + item.pressure;
    }, 0) / filtered.length;
  }

  return {
    pressureMeanToDate: mean(values),
    pressureMeanLast3Days: mean(values.filter(function (item) { return item.daysAgo <= 3; })),
    pressureMeanLast7Days: mean(values.filter(function (item) { return item.daysAgo <= 7; }))
  };
}

function buildPressureResponseSamplesForBrew_(measurements, brewDate, batchId) {
  const rows = (measurements || []).slice().sort(function (a, b) {
    return measurementSortTime_(a) - measurementSortTime_(b);
  });
  const samples = [];
  let latestCarb = null;
  let latestCarbDate = null;
  let latestPressure = null;
  let latestTemp = null;

  rows.forEach(function (measurement, index) {
    const currentCarb = pressureModelNumber_(measurement.carbonation);
    const currentPressure = pressureModelNumber_(measurement.pressure);
    const currentTemp = pressureModelNumber_(measurement.temp);
    const beforeCarb = currentCarb !== null ? currentCarb : latestCarb;
    // A pressure-changing note often shares the row with the post-action
    // pressure. Prefer the previous measurement as the "before" pressure so
    // compound notes such as 0 -> 0.2 -> 1.4 learn the actual correction.
    const beforePressure = latestPressure !== null ? latestPressure : currentPressure;
    const temp = currentTemp !== null ? currentTemp : latestTemp;
    const targetPressure = pressureTargetFromNote_(measurement.notes);

    if (
      targetPressure !== null &&
      beforeCarb !== null &&
      beforePressure !== null &&
      Math.abs(targetPressure - beforePressure) >= 0.02
    ) {
      const eventDate = parseDateOnly(measurement.date);
      if (eventDate) {
        for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex++) {
          const next = rows[nextIndex];
          const afterCarb = pressureModelNumber_(next.carbonation);
          const nextDate = parseDateOnly(next.date);
          if (afterCarb === null || !nextDate) continue;

          const elapsedDays = differenceInDays(eventDate, nextDate);
          if (elapsedDays < 1) continue;
          if (elapsedDays > 5) break;

          const pressureDelta = targetPressure - beforePressure;
          const carbonationDelta = afterCarb - beforeCarb;
          const brewDay = differenceInDays(brewDate, eventDate);
          const pressureHistory = pressureHistoryContext_(rows, index, eventDate);
          const carbSourceDate = currentCarb !== null
            ? parseDateOnly(measurement.date)
            : latestCarbDate;
          const carbAgeAtAdjustment = carbSourceDate
            ? Math.max(0, differenceInDays(carbSourceDate, eventDate))
            : null;

          samples.push({
            batchId: String(batchId),
            eventDate: String(measurement.date || ""),
            brewDay: brewDay,
            temp: temp,
            carbonationBefore: beforeCarb,
            carbAgeAtAdjustment: carbAgeAtAdjustment,
            pressureBefore: beforePressure,
            pressureMeanToDate: pressureHistory.pressureMeanToDate,
            pressureMeanLast3Days: pressureHistory.pressureMeanLast3Days,
            pressureMeanLast7Days: pressureHistory.pressureMeanLast7Days,
            targetPressure: targetPressure,
            pressureDelta: pressureDelta,
            carbonationAfter: afterCarb,
            carbonationDelta: carbonationDelta,
            elapsedDays: elapsedDays,
            success: pressureDelta * carbonationDelta > 0
          });
          break;
        }
      }
    }

    if (currentCarb !== null) {
      latestCarb = currentCarb;
      latestCarbDate = parseDateOnly(measurement.date);
    }
    if (currentPressure !== null) latestPressure = currentPressure;
    if (currentTemp !== null) latestTemp = currentTemp;
  });

  return samples;
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
