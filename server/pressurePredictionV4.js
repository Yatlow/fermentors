// ================================================================
// PRESSURE PREDICTION MODEL V4 — MANUAL HISTORICAL BACKFILL
// ================================================================
// IMPORTANT: this file is intentionally NOT called from runAsyncMaintenance_.
// V4 is experimental and must not consume historical reads automatically.
// Use startPressurePredictionV4Backfill_() once, then call
// pressurePredictionV4BackfillStep_() manually while validating read usage.
// ================================================================

const PRESSURE_V4_BACKFILL_STATE_KEY = "pressure_prediction_v4_backfill_manual";
const PRESSURE_V4_BACKFILL_PAGE_SIZE = 10;
const PRESSURE_V4_MAX_SAMPLES_PER_STYLE = 600;
const PRESSURE_V4_MAX_EQUILIBRIUM_POINTS_PER_STYLE = 200;

function pressureV4Number_(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function pressureV4DateTime_(measurement) {
  const date = parseDateOnly(measurement && measurement.date);
  if (!date) return null;
  const timeMatch = String(measurement && measurement.time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
  } else {
    date.setHours(12, 0, 0, 0);
  }
  return date.getTime();
}

function pressureV4DaySerial_(measurement) {
  const date = parseDateOnly(measurement && measurement.date);
  if (!date) return null;
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function pressureV4Note_(measurement) {
  return String(measurement && measurement.notes || "");
}

function pressureV4IsBottomCarbonation_(measurement) {
  return pressureV4Note_(measurement).indexOf("גיזוז מלמטה") !== -1;
}

function pressureV4OrdinaryTarget_(measurement) {
  if (pressureV4IsBottomCarbonation_(measurement)) return null;
  return pressureTargetFromNote_(measurement && measurement.notes);
}

function pressureV4IsExplicitClose_(measurement) {
  return /סגירת\s+(?:לחץ|מיכל)|סגירה\s+(?:לחץ|מיכל)|סגירת/i.test(
    pressureV4Note_(measurement)
  );
}

function pressureV4DetectT0_(measurements) {
  const rows = (measurements || []).slice().sort(function (a, b) {
    return pressureV4DateTime_(a) - pressureV4DateTime_(b);
  });

  let explicit = null;
  let fallback = null;

  rows.forEach(function (row, index) {
    const pressure = pressureV4Number_(row && row.pressure);
    const time = pressureV4DateTime_(row);
    if (pressure === null || time === null || pressure < 0.1) return;

    if (!fallback) fallback = { row: row, index: index, time: time, pressure: pressure };
    if (!explicit && pressureV4IsExplicitClose_(row)) {
      explicit = { row: row, index: index, time: time, pressure: pressure };
    }
  });

  const chosen = explicit || fallback;
  if (!chosen) return null;

  let previousPressure = null;
  for (let index = chosen.index - 1; index >= 0; index--) {
    const pressure = pressureV4Number_(rows[index] && rows[index].pressure);
    if (pressure !== null) {
      previousPressure = pressure;
      break;
    }
  }

  return {
    dateTimeMs: chosen.time,
    date: String(chosen.row.date || ""),
    source: explicit ? "explicit_close" : "first_positive_pressure",
    pressure: chosen.pressure,
    previousPressure: previousPressure
  };
}

function pressureV4WeightedMean_(segments) {
  if (!segments.length) return null;
  const hours = segments.reduce(function (sum, item) { return sum + item.hours; }, 0);
  if (hours <= 0) return null;
  return segments.reduce(function (sum, item) {
    return sum + item.value * item.hours;
  }, 0) / hours;
}

function pressureV4Exposure_(rows, t0Ms, endMs) {
  const ordered = (rows || [])
    .map(function (row) {
      return {
        time: pressureV4DateTime_(row),
        pressure: pressureV4Number_(row && row.pressure),
        temp: pressureV4Number_(row && row.temp)
      };
    })
    .filter(function (row) {
      return row.time !== null && row.time >= t0Ms && row.time <= endMs;
    })
    .sort(function (a, b) { return a.time - b.time; });

  let lastPressure = null;
  let lastTemp = null;
  let cursor = t0Ms;
  const pressureSegments = [];
  const tempSegments = [];
  let coveredHours = 0;

  function consume(until) {
    const hours = Math.max(0, (until - cursor) / 3600000);
    if (hours <= 0) {
      cursor = until;
      return;
    }
    if (lastPressure !== null) {
      pressureSegments.push({ value: lastPressure, hours: hours, end: until });
      coveredHours += hours;
    }
    if (lastTemp !== null) {
      tempSegments.push({ value: lastTemp, hours: hours });
    }
    cursor = until;
  }

  ordered.forEach(function (row) {
    consume(row.time);
    if (row.pressure !== null) lastPressure = row.pressure;
    if (row.temp !== null) lastTemp = row.temp;
  });
  consume(endMs);

  function trailingMean(startMs) {
    const overlaps = [];
    pressureSegments.forEach(function (segment) {
      const segmentStart = segment.end - segment.hours * 3600000;
      const from = Math.max(segmentStart, startMs);
      const to = Math.min(segment.end, endMs);
      const hours = Math.max(0, (to - from) / 3600000);
      if (hours > 0) overlaps.push({ value: segment.value, hours: hours });
    });
    return pressureV4WeightedMean_(overlaps);
  }

  const hoursSinceT0 = Math.max(0, (endMs - t0Ms) / 3600000);
  return {
    hoursSinceT0: hoursSinceT0,
    pressureMean: pressureV4WeightedMean_(pressureSegments),
    pressureMean24h: trailingMean(endMs - 24 * 3600000),
    pressureMean48h: trailingMean(endMs - 48 * 3600000),
    temperatureMean: pressureV4WeightedMean_(tempSegments),
    pressurePoints: ordered.filter(function (row) { return row.pressure !== null; }).length,
    temperaturePoints: ordered.filter(function (row) { return row.temp !== null; }).length,
    coveredHours: coveredHours,
    coverageRatio: hoursSinceT0 > 0 ? Math.min(1, coveredHours / hoursSinceT0) : 0
  };
}

function pressureV4Quality_(exposure) {
  if (
    exposure.coverageRatio >= 0.75 &&
    exposure.pressurePoints >= 4 &&
    exposure.temperaturePoints >= 3
  ) return "high";

  if (
    exposure.coverageRatio >= 0.4 &&
    exposure.pressurePoints >= 2 &&
    exposure.temperaturePoints >= 1
  ) return "medium";

  return "low";
}

function pressureV4BuildSamples_(measurements, batchId) {
  const rows = (measurements || []).slice().sort(function (a, b) {
    return pressureV4DateTime_(a) - pressureV4DateTime_(b);
  });
  const t0 = pressureV4DetectT0_(rows);
  if (!t0) return [];

  const samples = [];

  rows.forEach(function (row, actionIndex) {
    const actionTime = pressureV4DateTime_(row);
    if (actionTime === null || actionTime < t0.dateTimeMs) return;

    const targetPressure = pressureV4OrdinaryTarget_(row);
    const carbonationBefore = pressureV4Number_(row && row.carbonation);
    if (targetPressure === null || carbonationBefore === null) return;

    let pressureBefore = null;
    for (let index = actionIndex - 1; index >= 0; index--) {
      pressureBefore = pressureV4Number_(rows[index] && rows[index].pressure);
      if (pressureBefore !== null) break;
    }
    if (pressureBefore === null) {
      pressureBefore = pressureV4Number_(row && row.pressure);
    }
    if (pressureBefore === null) return;

    let day1 = null;
    let outcome = null;

    for (let nextIndex = actionIndex + 1; nextIndex < rows.length; nextIndex++) {
      const candidate = rows[nextIndex];
      const serial = pressureV4DaySerial_(candidate);
      const actionSerial = pressureV4DaySerial_(row);
      if (serial === null || actionSerial === null) continue;

      const diff = serial - actionSerial;
      if (diff > 2) break;

      if (
        diff > 0 &&
        (
          pressureV4IsBottomCarbonation_(candidate) ||
          pressureV4OrdinaryTarget_(candidate) !== null
        )
      ) {
        return;
      }

      const carb = pressureV4Number_(candidate && candidate.carbonation);
      if (carb === null) continue;
      if (diff === 1 && !day1) day1 = { carbonation: carb, date: String(candidate.date || "") };
      if (diff === 2 && !outcome) {
        outcome = { carbonation: carb, date: String(candidate.date || "") };
        break;
      }
    }

    if (!outcome) return;

    const exposure = pressureV4Exposure_(rows, t0.dateTimeMs, actionTime);

    samples.push({
      batchId: String(batchId || ""),
      t0Date: t0.date,
      t0Source: t0.source,
      actionDate: String(row.date || ""),
      carbonationBefore: carbonationBefore,
      pressureBefore: pressureBefore,
      targetPressure: targetPressure,
      temp: pressureV4Number_(row && row.temp),
      hoursSinceT0: Math.max(0, (actionTime - t0.dateTimeMs) / 3600000),
      exposure: exposure,
      intermediateDay1: day1,
      carbonationAfter2d: outcome.carbonation,
      carbonationDelta2d: outcome.carbonation - carbonationBefore,
      actionPressureDelta: targetPressure - pressureBefore,
      quality: pressureV4Quality_(exposure)
    });
  });

  return samples;
}

function pressureV4Median_(values) {
  const sorted = (values || []).filter(function (value) {
    return Number.isFinite(value);
  }).slice().sort(function (a, b) { return a - b; });
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pressureV4BuildEquilibriumPoint_(measurements, batchId, targetCarbonation) {
  const t0 = pressureV4DetectT0_(measurements);
  if (!t0 || !Number.isFinite(targetCarbonation)) return null;

  const byDate = {};
  (measurements || []).forEach(function (row) {
    const time = pressureV4DateTime_(row);
    if (time === null || time < t0.dateTimeMs) return;
    const date = String(row.date || "");
    if (!date) return;
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(row);
  });

  const days = Object.keys(byDate).map(function (date) {
    const rows = byDate[date];
    const pressures = rows.map(function (row) {
      return pressureV4Number_(row && row.pressure);
    }).filter(function (value) { return value !== null; });
    const temps = rows.map(function (row) {
      return pressureV4Number_(row && row.temp);
    }).filter(function (value) { return value !== null; });
    const carbs = rows.map(function (row) {
      return pressureV4Number_(row && row.carbonation);
    }).filter(function (value) { return value !== null; });

    return {
      date: date,
      pressure: pressureV4Median_(pressures),
      temp: pressureV4Median_(temps),
      carbs: carbs,
      intervention: rows.some(function (row) {
        return pressureV4IsBottomCarbonation_(row) ||
          pressureV4OrdinaryTarget_(row) !== null;
      })
    };
  }).filter(function (day) {
    return day.pressure !== null && day.temp !== null && day.temp <= 9;
  }).sort(function (a, b) {
    const ad = parseDateOnly(a.date);
    const bd = parseDateOnly(b.date);
    return (ad ? ad.getTime() : 0) - (bd ? bd.getTime() : 0);
  });

  let best = null;

  for (let start = 0; start < days.length; start++) {
    for (let end = start + 2; end < days.length; end++) {
      const window = days.slice(start, end + 1);
      if (window.some(function (day) { return day.intervention; })) continue;

      const pressures = window.map(function (day) { return day.pressure; });
      const temps = window.map(function (day) { return day.temp; });
      if (Math.max.apply(null, pressures) - Math.min.apply(null, pressures) > 0.1) continue;
      if (Math.max.apply(null, temps) - Math.min.apply(null, temps) > 2) continue;

      const carbs = [];
      window.forEach(function (day) {
        Array.prototype.push.apply(carbs, day.carbs);
      });
      const onTarget = carbs.filter(function (carb) {
        return Math.abs(carb - targetCarbonation) <= 0.05;
      });
      if (!onTarget.length) continue;
      if (carbs.some(function (carb) {
        return Math.abs(carb - targetCarbonation) > 0.1;
      })) continue;

      if (!best || window.length > best.window.length) {
        best = { window: window, checks: onTarget.length };
      }
    }
  }

  if (!best) return null;

  const pressure = pressureV4Median_(best.window.map(function (day) { return day.pressure; }));
  const temp = pressureV4Median_(best.window.map(function (day) { return day.temp; }));
  if (pressure === null || temp === null) return null;

  return {
    batchId: String(batchId || ""),
    temperature: Math.round(temp * 100) / 100,
    pressure: Math.round(pressure * 1000) / 1000,
    stableDays: best.window.length,
    carbonationChecks: best.checks,
    quality: best.window.length >= 4 && best.checks >= 2 ? "high" : "medium"
  };
}

function pressureV4ReadCarbonationTargets_(projectId) {
  const defaults = {
    ipa: 2.45,
    "פייל": 2.4,
    "לאגר": 2.5,
    "הופי": 2.5,
    "חיטה": 2.5,
    "סטאוט": 2.2,
    other: 2.45
  };

  try {
    const result = firestoreRequest_(
      "https://firestore.googleapis.com/v1/projects/" +
      encodeURIComponent(projectId) +
      "/databases/(default)/documents/specs?pageSize=100"
    );
    const docs = result.documents || [];
    const carbonationDoc = docs.find(function (doc) {
      return String(doc.name || "").split("/").pop() === "carbonation";
    });
    if (!carbonationDoc) return defaults;
    return Object.assign(
      {},
      defaults,
      firestoreFieldsToObject_(carbonationDoc.fields || {})
    );
  } catch (error) {
    console.log("V4 specs read failed; using defaults: " + error.message);
    return defaults;
  }
}

function pressureV4GetModel_(projectId, styleKey) {
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/pressurePredictionModelsV4/" +
    encodeURIComponent(styleKey);

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("V4 model read failed: " + response.getContentText());
  }

  const parsed = JSON.parse(response.getContentText() || "{}");
  return firestoreFieldsToObject_(parsed.fields || {});
}

function pressureV4SampleKey_(sample) {
  return [
    String(sample && sample.batchId || ""),
    String(sample && sample.actionDate || ""),
    String(sample && sample.targetPressure || "")
  ].join("|");
}

function pressureV4MergeByKey_(existing, incoming, keyFn, maxItems) {
  const map = new Map();
  (existing || []).forEach(function (item) {
    if (item) map.set(keyFn(item), item);
  });
  (incoming || []).forEach(function (item) {
    if (item) map.set(keyFn(item), item);
  });
  return Array.from(map.values()).slice(-maxItems);
}

function pressureV4WriteModel_(projectId, styleKey, incomingSamples, incomingPoints) {
  const existing = pressureV4GetModel_(projectId, styleKey) || {};
  const samples = pressureV4MergeByKey_(
    Array.isArray(existing.samples) ? existing.samples : [],
    incomingSamples || [],
    pressureV4SampleKey_,
    PRESSURE_V4_MAX_SAMPLES_PER_STYLE
  );
  const points = pressureV4MergeByKey_(
    Array.isArray(existing.equilibriumPoints) ? existing.equilibriumPoints : [],
    incomingPoints || [],
    function (point) { return String(point && point.batchId || ""); },
    PRESSURE_V4_MAX_EQUILIBRIUM_POINTS_PER_STYLE
  );

  return setFirestoreDocument(
    projectId,
    "pressurePredictionModelsV4/" + encodeURIComponent(styleKey),
    {
      version: 4,
      style: styleKey,
      samples: samples,
      sampleCount: samples.length,
      equilibriumPoints: points,
      equilibriumPointCount: points.length,
      updatedAt: new Date().toISOString()
    }
  );
}

function startPressurePredictionV4Backfill_() {
  PropertiesService.getScriptProperties().setProperty(
    PRESSURE_V4_BACKFILL_STATE_KEY,
    JSON.stringify({
      active: true,
      pageToken: "",
      scannedBrews: 0,
      processedBrews: 0,
      startedAt: new Date().toISOString()
    })
  );
  return { started: true, automatic: false };
}

function pressurePredictionV4BackfillState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(
    PRESSURE_V4_BACKFILL_STATE_KEY
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function pressurePredictionV4BackfillStep_() {
  const props = PropertiesService.getScriptProperties();
  const state = pressurePredictionV4BackfillState_();
  if (!state || state.active !== true) {
    return { skipped: true, reason: "not_started_or_completed" };
  }

  const projectId = FIREBASE_PROJECT_ID;
  const targets = pressureV4ReadCarbonationTargets_(projectId);

  let url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/brews?pageSize=" +
    PRESSURE_V4_BACKFILL_PAGE_SIZE;

  if (state.pageToken) {
    url += "&pageToken=" + encodeURIComponent(state.pageToken);
  }

  const page = firestoreRequest_(url);
  const documents = page.documents || [];
  const byStyle = {};
  const pointsByStyle = {};

  let processed = 0;

  documents.forEach(function (document) {
    const batchId = String(document.name || "").split("/").pop();
    const data = firestoreFieldsToObject_(document.fields || {});
    const styleKey = normalizePressureModelStyle_(data.beerStyle);
    if (!batchId || !styleKey) return;

    try {
      const measurements = getMeasurementsForBrew(projectId, batchId);
      const samples = pressureV4BuildSamples_(measurements, batchId);
      const target = pressureV4Number_(targets[styleKey] != null
        ? targets[styleKey]
        : targets.other);
      const point = pressureV4BuildEquilibriumPoint_(
        measurements,
        batchId,
        target
      );

      if (!byStyle[styleKey]) byStyle[styleKey] = [];
      Array.prototype.push.apply(byStyle[styleKey], samples);

      if (!pointsByStyle[styleKey]) pointsByStyle[styleKey] = [];
      if (point) pointsByStyle[styleKey].push(point);
      processed++;
    } catch (error) {
      console.log("V4 backfill skipped batch " + batchId + ": " + error.message);
    }
  });

  const touchedStyles = {};
  Object.keys(byStyle).concat(Object.keys(pointsByStyle)).forEach(function (styleKey) {
    touchedStyles[styleKey] = true;
  });

  Object.keys(touchedStyles).forEach(function (styleKey) {
    pressureV4WriteModel_(
      projectId,
      styleKey,
      byStyle[styleKey] || [],
      pointsByStyle[styleKey] || []
    );
  });

  const nextPageToken = page.nextPageToken || "";
  const nextState = {
    active: Boolean(nextPageToken),
    completed: !nextPageToken,
    pageToken: nextPageToken,
    scannedBrews: Number(state.scannedBrews || 0) + documents.length,
    processedBrews: Number(state.processedBrews || 0) + processed,
    startedAt: state.startedAt || null,
    updatedAt: new Date().toISOString()
  };
  if (!nextPageToken) nextState.completedAt = new Date().toISOString();

  props.setProperty(PRESSURE_V4_BACKFILL_STATE_KEY, JSON.stringify(nextState));

  return {
    skipped: false,
    automatic: false,
    completed: !nextPageToken,
    scannedThisStep: documents.length,
    processedThisStep: processed,
    touchedStyles: Object.keys(touchedStyles),
    state: nextState
  };
}
