// ================================================================
// PRESSURE PREDICTION MODEL V4 — RESUMABLE HISTORICAL BACKFILL
// ================================================================
// The maintenance trigger advances this backfill within a strict Firestore-read
// allowance. Before the 10:00 Asia/Jerusalem quota reset on the first day it
// uses at most 3k reads; each quota day beginning at 10:00 receives 15k reads.
// Progress is durable and the scan stops permanently when history is complete.
// ================================================================

const PRESSURE_V4_BACKFILL_STATE_KEY = "pressure_prediction_v4_backfill_v1";
const PRESSURE_V4_BACKFILL_PAGE_SIZE = 1; // keep quota overshoot bounded to one brew
const PRESSURE_V4_INITIAL_PRE_RESET_BUDGET = 3000;
const PRESSURE_V4_PRE_RESET_FINAL_BUDGET = 5000;
const PRESSURE_V4_DAILY_READ_BUDGET = 15000;
const PRESSURE_V4_2026_09_19_POST_RESET_BUDGET = 10000;
const PRESSURE_V4_TIMEZONE = "Asia/Jerusalem";
const PRESSURE_V4_RESET_HOUR = 10;
const PRESSURE_V4_MAX_RUN_MS = 120000;
const PRESSURE_V4_FINAL_PRE_RESET_RUN_MS = 285000;
const PRESSURE_V4_MAX_SAMPLES_PER_STYLE = 600;
const PRESSURE_V4_MAX_TRANSITIONS_PER_STYLE = 800;
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
    pressureHours: pressureSegments.reduce(function (sum, segment) {
      return sum + segment.value * segment.hours;
    }, 0),
    temperatureHours: tempSegments.reduce(function (sum, segment) {
      return sum + segment.value * segment.hours;
    }, 0),
    equilibriumDeltaBarHours: null,
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

function pressureV4EquilibriumCarbonation_(temperatureC, gaugePressureBar) {
  if (!Number.isFinite(temperatureC) || !Number.isFinite(gaugePressureBar)) {
    return null;
  }

  const tF = temperatureC * 9 / 5 + 32;
  const psi = gaugePressureBar * 14.5037738;
  const a = -0.0684226;
  const b = 0.173354 * tF + 4.24267;
  const cc =
    -16.6999 -
    0.0101059 * tF +
    0.00116512 * tF * tF -
    psi;
  const discriminant = b * b - 4 * a * cc;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  const candidates = [
    (-b + root) / (2 * a),
    (-b - root) / (2 * a)
  ].filter(function (value) {
    return Number.isFinite(value) && value > 0 && value < 10;
  });
  if (!candidates.length) return null;
  return Math.min.apply(null, candidates);
}

function pressureV4TransitionPath_(rows, startMs, endMs) {
  const ordered = (rows || []).map(function (row) {
    return {
      row: row,
      time: pressureV4DateTime_(row),
      pressure: pressureV4Number_(row && row.pressure),
      temp: pressureV4Number_(row && row.temp)
    };
  }).filter(function (item) {
    return item.time !== null && item.time <= endMs;
  }).sort(function (a, b) {
    return a.time - b.time;
  });

  let pressure = null;
  let temp = null;
  ordered.forEach(function (item) {
    if (item.time > startMs) return;
    if (item.pressure !== null) pressure = item.pressure;
    if (item.temp !== null) temp = item.temp;
  });
  if (pressure === null || temp === null) return null;

  const segments = [];
  let cursor = startMs;
  let weightedPressure = 0;
  let weightedTemp = 0;
  let totalHours = 0;
  let maxTemp = temp;

  ordered.forEach(function (item) {
    if (item.time <= startMs || item.time > endMs) return;
    const hours = Math.max(0, (item.time - cursor) / 3600000);
    if (hours > 0) {
      segments.push({
        hours: hours,
        pressure: pressure,
        temp: temp
      });
      weightedPressure += pressure * hours;
      weightedTemp += temp * hours;
      totalHours += hours;
      cursor = item.time;
    }
    if (item.pressure !== null) pressure = item.pressure;
    if (item.temp !== null) {
      temp = item.temp;
      maxTemp = Math.max(maxTemp, temp);
    }
  });

  const tailHours = Math.max(0, (endMs - cursor) / 3600000);
  if (tailHours > 0) {
    segments.push({
      hours: tailHours,
      pressure: pressure,
      temp: temp
    });
    weightedPressure += pressure * tailHours;
    weightedTemp += temp * tailHours;
    totalHours += tailHours;
  }

  if (totalHours <= 0) return null;

  return {
    segments: segments,
    currentPressure: segments.length ? segments[0].pressure : pressure,
    currentTemp: segments.length ? segments[0].temp : temp,
    pressureMean: weightedPressure / totalHours,
    tempMean: weightedTemp / totalHours,
    maxTemp: maxTemp,
    totalHours: totalHours
  };
}

function pressureV4SimulatePath_(startCarbonation, segments, kPerHour) {
  let carbonation = startCarbonation;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const equilibrium = pressureV4EquilibriumCarbonation_(
      segment.temp,
      segment.pressure
    );
    if (equilibrium === null) return null;
    const decay = Math.exp(-kPerHour * segment.hours);
    carbonation =
      equilibrium - (equilibrium - carbonation) * decay;
  }
  return carbonation;
}

function pressureV4FitK_(startCarbonation, endCarbonation, segments) {
  let bestK = null;
  let bestError = Infinity;

  // Log grid covers time constants from roughly 2h to >400 days.
  for (let index = 0; index <= 100; index++) {
    const exponent = -4 + index * (Math.log10(0.5) + 4) / 100;
    const k = Math.pow(10, exponent);
    const predicted = pressureV4SimulatePath_(
      startCarbonation,
      segments,
      k
    );
    if (predicted === null) continue;
    const error = Math.abs(predicted - endCarbonation);
    if (error < bestError) {
      bestError = error;
      bestK = k;
    }
  }

  if (bestK === null) return null;

  // Refine locally around the best logarithmic candidate.
  const low = Math.max(0.00005, bestK / 1.5);
  const high = Math.min(0.8, bestK * 1.5);
  for (let index = 0; index <= 60; index++) {
    const k = low + (high - low) * index / 60;
    const predicted = pressureV4SimulatePath_(
      startCarbonation,
      segments,
      k
    );
    if (predicted === null) continue;
    const error = Math.abs(predicted - endCarbonation);
    if (error < bestError) {
      bestError = error;
      bestK = k;
    }
  }

  return {
    kPerHour: bestK,
    error: bestError
  };
}

function pressureV4BuildTransitions_(measurements, batchId) {
  const rows = (measurements || []).slice().sort(function (a, b) {
    return pressureV4DateTime_(a) - pressureV4DateTime_(b);
  });
  const t0 = pressureV4DetectT0_(rows);
  if (!t0) return [];

  const checks = rows.map(function (row) {
    return {
      row: row,
      time: pressureV4DateTime_(row),
      carbonation: pressureV4Number_(row && row.carbonation)
    };
  }).filter(function (item) {
    return item.time !== null &&
      item.time >= t0.dateTimeMs &&
      item.carbonation !== null;
  });

  const transitions = [];

  for (let index = 0; index < checks.length - 1; index++) {
    const start = checks[index];
    const end = checks[index + 1];
    const durationHours = (end.time - start.time) / 3600000;
    if (durationHours < 8 || durationHours > 120) continue;

    const contaminated = rows.some(function (row) {
      const time = pressureV4DateTime_(row);
      return time !== null &&
        time > start.time &&
        time <= end.time &&
        pressureV4IsBottomCarbonation_(row);
    });
    if (contaminated) continue;

    const path = pressureV4TransitionPath_(rows, start.time, end.time);
    if (!path || path.maxTemp > 9) continue;

    const fit = pressureV4FitK_(
      start.carbonation,
      end.carbonation,
      path.segments
    );
    if (!fit || fit.error > 0.06) continue;

    const exposure = pressureV4Exposure_(
      rows,
      t0.dateTimeMs,
      start.time
    );

    let quality = "low";
    if (
      fit.error <= 0.02 &&
      durationHours >= 18 &&
      durationHours <= 72
    ) {
      quality = "high";
    } else if (fit.error <= 0.04) {
      quality = "medium";
    }

    transitions.push({
      batchId: String(batchId || ""),
      startDateTimeMs: start.time,
      endDateTimeMs: end.time,
      durationHours: Math.round(durationHours * 100) / 100,
      startCarbonation: start.carbonation,
      endCarbonation: end.carbonation,
      currentPressure: path.currentPressure,
      currentTemp: path.currentTemp,
      hoursSinceT0: Math.max(
        0,
        (start.time - t0.dateTimeMs) / 3600000
      ),
      exposure: exposure,
      pressureMeanDuring:
        Math.round(path.pressureMean * 1000) / 1000,
      temperatureMeanDuring:
        Math.round(path.tempMean * 100) / 100,
      kPerHour: Math.round(fit.kPerHour * 1000000) / 1000000,
      quality: quality
    });
  }

  return transitions;
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
      t0: {
        index: -1,
        dateTimeMs: t0.dateTimeMs,
        source: t0.source,
        pressure: t0.pressure,
        previousPressure: t0.previousPressure
      },
      actionDateTimeMs: actionTime,
      actionDate: String(row.date || ""),
      carbonationBefore: carbonationBefore,
      currentPressure: pressureBefore,
      targetPressure: targetPressure,
      currentTemp: pressureV4Number_(row && row.temp),
      hoursSinceT0: Math.max(0, (actionTime - t0.dateTimeMs) / 3600000),
      exposure: exposure,
      intermediateDay1: day1
        ? {
            carbonation: day1.carbonation,
            dateTimeMs: actionTime + 24 * 3600000,
            calendarDaysAfterAction: 1
          }
        : null,
      primaryOutcome: {
        carbonation: outcome.carbonation,
        dateTimeMs: actionTime + 2 * 24 * 3600000,
        calendarDaysAfterAction: 2
      },
      carbonationDelta: outcome.carbonation - carbonationBefore,
      actionPressureDelta: targetPressure - pressureBefore,
      quality: pressureV4Quality_(exposure)
    });
  });

  return samples;
}

function pressureV4BuildPassiveSamples_(measurements, batchId) {
  const rows = (measurements || []).slice().sort(function (a, b) {
    return pressureV4DateTime_(a) - pressureV4DateTime_(b);
  });
  const t0 = pressureV4DetectT0_(rows);
  if (!t0) return [];

  const samples = [];

  rows.forEach(function (row, startIndex) {
    const startTime = pressureV4DateTime_(row);
    if (startTime === null || startTime < t0.dateTimeMs) return;
    if (
      pressureV4IsBottomCarbonation_(row) ||
      pressureV4OrdinaryTarget_(row) !== null
    ) return;

    const carbonationBefore = pressureV4Number_(row && row.carbonation);
    if (carbonationBefore === null) return;

    let currentPressure = pressureV4Number_(row && row.pressure);
    let currentTemp = pressureV4Number_(row && row.temp);

    for (let index = startIndex - 1; index >= 0; index--) {
      if (currentPressure === null) {
        currentPressure = pressureV4Number_(rows[index] && rows[index].pressure);
      }
      if (currentTemp === null) {
        currentTemp = pressureV4Number_(rows[index] && rows[index].temp);
      }
      if (currentPressure !== null && currentTemp !== null) break;
    }
    if (currentPressure === null) return;

    let outcome = null;
    for (let nextIndex = startIndex + 1; nextIndex < rows.length; nextIndex++) {
      const candidate = rows[nextIndex];
      const serial = pressureV4DaySerial_(candidate);
      const startSerial = pressureV4DaySerial_(row);
      if (serial === null || startSerial === null) continue;

      const diff = serial - startSerial;
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
      if (carb !== null && diff === 2) {
        outcome = {
          carbonation: carb,
          dateTimeMs: pressureV4DateTime_(candidate)
        };
        break;
      }
    }

    if (!outcome) return;

    const exposure = pressureV4Exposure_(rows, t0.dateTimeMs, startTime);

    samples.push({
      batchId: String(batchId || ""),
      sampleDateTimeMs: startTime,
      sampleDate: String(row.date || ""),
      carbonationBefore: carbonationBefore,
      currentPressure: currentPressure,
      currentTemp: currentTemp,
      hoursSinceT0: Math.max(0, (startTime - t0.dateTimeMs) / 3600000),
      exposure: exposure,
      primaryOutcome: {
        carbonation: outcome.carbonation,
        dateTimeMs: outcome.dateTimeMs !== null
          ? outcome.dateTimeMs
          : startTime + 2 * 24 * 3600000,
        calendarDaysAfterAction: 2
      },
      carbonationDelta: outcome.carbonation - carbonationBefore,
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

function pressureV4TransitionKey_(sample) {
  return [
    String(sample && sample.batchId || ""),
    String(sample && sample.startDateTimeMs || ""),
    String(sample && sample.endDateTimeMs || "")
  ].join("|");
}

function pressureV4PassiveSampleKey_(sample) {
  return [
    String(sample && sample.batchId || ""),
    String(sample && sample.sampleDate || "")
  ].join("|");
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

function pressureV4WriteModel_(
  projectId,
  styleKey,
  incomingSamples,
  incomingPassiveSamples,
  incomingTransitions,
  incomingPoints
) {
  const existing = pressureV4GetModel_(projectId, styleKey) || {};
  const samples = pressureV4MergeByKey_(
    Array.isArray(existing.samples) ? existing.samples : [],
    incomingSamples || [],
    pressureV4SampleKey_,
    PRESSURE_V4_MAX_SAMPLES_PER_STYLE
  );
  const passiveSamples = pressureV4MergeByKey_(
    Array.isArray(existing.passiveSamples) ? existing.passiveSamples : [],
    incomingPassiveSamples || [],
    pressureV4PassiveSampleKey_,
    PRESSURE_V4_MAX_SAMPLES_PER_STYLE
  );
  const transitions = pressureV4MergeByKey_(
    Array.isArray(existing.transitions) ? existing.transitions : [],
    incomingTransitions || [],
    pressureV4TransitionKey_,
    PRESSURE_V4_MAX_TRANSITIONS_PER_STYLE
  );
  const points = pressureV4MergeByKey_(
    Array.isArray(existing.equilibriumPoints) ? existing.equilibriumPoints : [],
    incomingPoints || [],
    function (point) { return String(point && point.batchId || ""); },
    PRESSURE_V4_MAX_EQUILIBRIUM_POINTS_PER_STYLE
  );
  const readiness = pressureV4ModelReadiness_(
    samples,
    points,
    transitions
  );

  setFirestoreDocument(
    projectId,
    "pressurePredictionModelsV4/" + encodeURIComponent(styleKey),
    {
      version: 4,
      style: styleKey,
      samples: samples,
      sampleCount: samples.length,
      passiveSamples: passiveSamples,
      passiveSampleCount: passiveSamples.length,
      transitions: transitions,
      transitionCount: transitions.length,
      equilibriumPoints: points,
      equilibriumPointCount: points.length,
      readiness: readiness,
      updatedAt: new Date().toISOString()
    }
  );

  return {
    sampleCount: samples.length,
    passiveSampleCount: passiveSamples.length,
    transitionCount: transitions.length,
    equilibriumPointCount: points.length,
    readiness: readiness
  };
}

function pressureV4QuotaWindow_(now) {
  const current = now || new Date();
  const dateText = Utilities.formatDate(current, PRESSURE_V4_TIMEZONE, "yyyy-MM-dd");
  const hour = Number(Utilities.formatDate(current, PRESSURE_V4_TIMEZONE, "H"));

  if (hour >= PRESSURE_V4_RESET_HOUR) {
    return { key: dateText + "@10" };
  }

  const previous = new Date(current.getTime() - 24 * 60 * 60 * 1000);
  return {
    key: Utilities.formatDate(previous, PRESSURE_V4_TIMEZONE, "yyyy-MM-dd") + "@10"
  };
}

function pressureV4BackfillPolicy_(now, state, quotaKey) {
  const current = now || new Date();
  const dateText = Utilities.formatDate(
    current,
    PRESSURE_V4_TIMEZONE,
    "yyyy-MM-dd"
  );
  const hour = Number(
    Utilities.formatDate(current, PRESSURE_V4_TIMEZONE, "H")
  );
  const minute = Number(
    Utilities.formatDate(current, PRESSURE_V4_TIMEZONE, "m")
  );

  const finalPreResetBurst =
    dateText === "2026-09-19" &&
    hour === 9 &&
    minute >= 50;

  if (finalPreResetBurst) {
    return {
      budget: PRESSURE_V4_PRE_RESET_FINAL_BUDGET,
      maxRunMs: PRESSURE_V4_FINAL_PRE_RESET_RUN_MS,
      restartForPassive: !state.passiveRescanStartedAt
    };
  }

  if (quotaKey === "2026-09-19@10") {
    return {
      budget: PRESSURE_V4_2026_09_19_POST_RESET_BUDGET,
      maxRunMs: PRESSURE_V4_MAX_RUN_MS,
      restartForPassive: false
    };
  }

  const isInitialWindow =
    String(state.initialQuotaWindowKey || "") === quotaKey;
  const budget = isInitialWindow
    ? Number(
        state.initialQuotaWindowBudget ||
        PRESSURE_V4_INITIAL_PRE_RESET_BUDGET
      )
    : PRESSURE_V4_DAILY_READ_BUDGET;

  return {
    budget: budget,
    maxRunMs: PRESSURE_V4_MAX_RUN_MS,
    restartForPassive: false
  };
}

function pressureV4ModelReadiness_(samples, equilibriumPoints, transitions) {
  const usable = (samples || []).filter(function (sample) {
    return sample &&
      sample.primaryOutcome &&
      Number(sample.primaryOutcome.calendarDaysAfterAction) === 2 &&
      Number.isFinite(Number(sample.carbonationDelta)) &&
      sample.quality !== "low";
  });
  const batchIds = {};
  usable.forEach(function (sample) {
    if (sample.batchId) batchIds[String(sample.batchId)] = true;
  });

  const goodEquilibrium = (equilibriumPoints || []).filter(function (point) {
    return point && point.quality !== "low";
  });

  const usableTransitions = (transitions || []).filter(function (sample) {
    return sample &&
      Number.isFinite(Number(sample.kPerHour)) &&
      Number(sample.kPerHour) > 0 &&
      sample.quality !== "low";
  });
  const transitionBatches = {};
  usableTransitions.forEach(function (sample) {
    if (sample.batchId) transitionBatches[String(sample.batchId)] = true;
  });

  const ready =
    usableTransitions.length >= 8 &&
    Object.keys(transitionBatches).length >= 4;

  return {
    ready: ready,
    usableSampleCount: usable.length,
    distinctBatchCount: Object.keys(batchIds).length,
    equilibriumPointCount: goodEquilibrium.length,
    usableTransitionCount: usableTransitions.length,
    distinctTransitionBatchCount: Object.keys(transitionBatches).length
  };
}

function startPressurePredictionV4Backfill_() {
  const now = new Date();
  const quota = pressureV4QuotaWindow_(now);
  const hour = Number(Utilities.formatDate(now, PRESSURE_V4_TIMEZONE, "H"));
  const initialWindowBudget =
    hour < PRESSURE_V4_RESET_HOUR
      ? PRESSURE_V4_INITIAL_PRE_RESET_BUDGET
      : PRESSURE_V4_DAILY_READ_BUDGET;

  PropertiesService.getScriptProperties().setProperty(
    PRESSURE_V4_BACKFILL_STATE_KEY,
    JSON.stringify({
      active: true,
      pageToken: "",
      scannedBrews: 0,
      processedBrews: 0,
      quotaWindowKey: quota.key,
      readsInWindow: 0,
      initialQuotaWindowKey: quota.key,
      initialQuotaWindowBudget: initialWindowBudget,
      startedAt: now.toISOString()
    })
  );
  return {
    started: true,
    automatic: true,
    quotaWindowKey: quota.key,
    budget: initialWindowBudget
  };
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
  if (!state) {
    return { skipped: true, reason: "not_started" };
  }

  const nowForPolicy = new Date();
  const quotaForPolicy = pressureV4QuotaWindow_(nowForPolicy);
  const policyBeforeActiveCheck = pressureV4BackfillPolicy_(
    nowForPolicy,
    state,
    quotaForPolicy.key
  );

  // The 09:50 one-off rescan must be able to restart even if an earlier
  // historical scan had already reached the end of the brews collection.
  if (
    state.active !== true &&
    policyBeforeActiveCheck.restartForPassive
  ) {
    state.active = true;
    state.completed = false;
    state.pageToken = "";
    state.passiveRescanStartedAt = nowForPolicy.toISOString();
    props.setProperty(
      PRESSURE_V4_BACKFILL_STATE_KEY,
      JSON.stringify(state)
    );
  }

  if (state.active !== true) {
    return { skipped: true, reason: "completed" };
  }

  const quota = pressureV4QuotaWindow_(new Date());
  if (String(state.quotaWindowKey || "") !== quota.key) {
    state.quotaWindowKey = quota.key;
    state.readsInWindow = 0;
  }

  const now = new Date();
  const currentHour = Number(
    Utilities.formatDate(now, PRESSURE_V4_TIMEZONE, "H")
  );
  const isPreResetWindow = currentHour < PRESSURE_V4_RESET_HOUR;
  const policy = pressureV4BackfillPolicy_(now, state, quota.key);
  const budget = policy.budget;

  if (policy.restartForPassive) {
    state.pageToken = "";
    state.active = true;
    state.completed = false;
    state.passiveRescanStartedAt = now.toISOString();
    props.setProperty(
      PRESSURE_V4_BACKFILL_STATE_KEY,
      JSON.stringify(state)
    );
    Logger.log(
      "V4 BACKFILL | 09:50 passive rescan started | budget " +
      budget
    );
  }

  const readsInWindow = Number(state.readsInWindow || 0);
  if (readsInWindow >= budget) {
    Logger.log(
      "V4 BACKFILL | paused: quota budget | reads " +
      readsInWindow + "/" + budget +
      " | processed brews " + Number(state.processedBrews || 0)
    );
    return {
      skipped: true,
      reason: "quota_window_budget_reached",
      quotaWindowKey: quota.key,
      readsInWindow: readsInWindow,
      budget: budget
    };
  }

  const projectId = FIREBASE_PROJECT_ID;
  const startedAtMs = Date.now();
  const targets = pressureV4ReadCarbonationTargets_(projectId);

  let readsThisRun = 1; // specs collection/list request
  const scannedAtStart = Number(state.scannedBrews || 0);
  const processedAtStart = Number(state.processedBrews || 0);
  let totalProcessedThisRun = 0;
  let totalScannedThisRun = 0;
  let pageToken = String(state.pageToken || "");
  let completed = false;
  const styleReadiness = {};

  while (
    Date.now() - startedAtMs < policy.maxRunMs &&
    readsInWindow + readsThisRun < budget
  ) {
    let url =
      "https://firestore.googleapis.com/v1/projects/" +
      encodeURIComponent(projectId) +
      "/databases/(default)/documents/brews?pageSize=" +
      PRESSURE_V4_BACKFILL_PAGE_SIZE;

    if (pageToken) {
      url += "&pageToken=" + encodeURIComponent(pageToken);
    }

    const page = firestoreRequest_(url);
    const documents = page.documents || [];
    readsThisRun += documents.length;
    totalScannedThisRun += documents.length;

    if (documents.length === 0) {
      completed = true;
      pageToken = "";
      break;
    }

    const byStyle = {};
    const passiveByStyle = {};
    const transitionsByStyle = {};
    const pointsByStyle = {};
    const bottomByStyle = {};
    let processedThisPage = 0;

    documents.forEach(function (document) {
      const batchId = String(document.name || "").split("/").pop();
      const data = firestoreFieldsToObject_(document.fields || {});
      const styleKey = normalizePressureModelStyle_(data.beerStyle);
      if (!batchId || !styleKey) return;

      try {
        const measurements = getMeasurementsForBrew(projectId, batchId);
        readsThisRun += measurements.length;

        const samples = pressureV4BuildSamples_(measurements, batchId);
        const passiveSamples = pressureV4BuildPassiveSamples_(
          measurements,
          batchId
        );
        const transitions = pressureV4BuildTransitions_(
          measurements,
          batchId
        );
        const target = pressureV4Number_(targets[styleKey] != null
          ? targets[styleKey]
          : targets.other);
        const point = pressureV4BuildEquilibriumPoint_(
          measurements,
          batchId,
          target
        );
        const brewDate = parseDateOnly(data.brewDate);
        const bottomSamples = brewDate
          ? buildBottomCarbonationSamplesForBrew_(
              measurements,
              brewDate,
              batchId
            )
          : [];

        if (!byStyle[styleKey]) byStyle[styleKey] = [];
        Array.prototype.push.apply(byStyle[styleKey], samples);

        if (!passiveByStyle[styleKey]) passiveByStyle[styleKey] = [];
        Array.prototype.push.apply(
          passiveByStyle[styleKey],
          passiveSamples
        );

        if (!transitionsByStyle[styleKey]) transitionsByStyle[styleKey] = [];
        Array.prototype.push.apply(
          transitionsByStyle[styleKey],
          transitions
        );

        if (!pointsByStyle[styleKey]) pointsByStyle[styleKey] = [];
        if (point) pointsByStyle[styleKey].push(point);

        if (!bottomByStyle[styleKey]) bottomByStyle[styleKey] = [];
        Array.prototype.push.apply(bottomByStyle[styleKey], bottomSamples);

        processedThisPage++;
      } catch (error) {
        console.log("V4 backfill skipped batch " + batchId + ": " + error.message);
      }
    });

    const touchedStyles = {};
    Object.keys(byStyle)
      .concat(Object.keys(passiveByStyle))
      .concat(Object.keys(transitionsByStyle))
      .concat(Object.keys(pointsByStyle))
      .concat(Object.keys(bottomByStyle))
      .forEach(function (styleKey) {
        touchedStyles[styleKey] = true;
      });

    Object.keys(touchedStyles).forEach(function (styleKey) {
      readsThisRun++;
      const writeResult = pressureV4WriteModel_(
        projectId,
        styleKey,
        byStyle[styleKey] || [],
        passiveByStyle[styleKey] || [],
        transitionsByStyle[styleKey] || [],
        pointsByStyle[styleKey] || []
      );
      styleReadiness[styleKey] = writeResult.readiness;

      if (bottomByStyle[styleKey] && bottomByStyle[styleKey].length > 0) {
        // Reuse the measurements already read for V4. Only the existing
        // bottom-model document read is additional; no measurement reread.
        readsThisRun++;
        writeMergedBottomCarbonationModel_(
          projectId,
          styleKey,
          bottomByStyle[styleKey]
        );
      }
    });

    totalProcessedThisRun += processedThisPage;

    const nextPageToken = page.nextPageToken || "";
    const nextState = {
      active: Boolean(nextPageToken),
      completed: !nextPageToken,
      pageToken: nextPageToken,
      scannedBrews: scannedAtStart + totalScannedThisRun,
      processedBrews: processedAtStart + totalProcessedThisRun,
      quotaWindowKey: quota.key,
      readsInWindow: readsInWindow + readsThisRun,
      initialQuotaWindowKey: state.initialQuotaWindowKey || (isPreResetWindow ? quota.key : ""),
      initialQuotaWindowBudget:
        Number(state.initialQuotaWindowBudget || 0) ||
        (isPreResetWindow ? PRESSURE_V4_INITIAL_PRE_RESET_BUDGET : PRESSURE_V4_DAILY_READ_BUDGET),
      passiveRescanStartedAt: state.passiveRescanStartedAt || null,
      startedAt: state.startedAt || null,
      updatedAt: new Date().toISOString()
    };
    if (!nextPageToken) nextState.completedAt = new Date().toISOString();

    props.setProperty(PRESSURE_V4_BACKFILL_STATE_KEY, JSON.stringify(nextState));

    // Keep local state aligned with persisted progress before continuing.
    state.pageToken = nextPageToken;
    state.scannedBrews = nextState.scannedBrews;
    state.processedBrews = nextState.processedBrews;
    state.readsInWindow = nextState.readsInWindow;
    state.initialQuotaWindowKey = nextState.initialQuotaWindowKey;
    state.initialQuotaWindowBudget = nextState.initialQuotaWindowBudget;

    pageToken = nextPageToken;
    if (!nextPageToken) {
      completed = true;
      break;
    }

    // We only know a brew's measurement count after reading it, so allow at
    // most the current brew to push slightly over the budget, then stop.
    if (readsInWindow + readsThisRun >= budget) break;
  }

  const finalReadsInWindow = readsInWindow + readsThisRun;
  const finalState = pressurePredictionV4BackfillState_() || state;
  const readinessText = Object.keys(styleReadiness).map(function (styleKey) {
    const readiness = styleReadiness[styleKey];
    return styleKey + "=" +
      (readiness.ready ? "READY" : "collecting") +
      "(" + Number(readiness.usableTransitionCount || 0) + " transitions," +
      Number(readiness.distinctTransitionBatchCount || 0) + " transition-batches," +
      readiness.usableSampleCount + " legacy-samples," +
      readiness.equilibriumPointCount + " eq)";
  }).join(" | ");

  Logger.log(
    "V4 BACKFILL | reads " + finalReadsInWindow + "/" + budget +
    " | this run " + readsThisRun +
    " | brews " + Number(finalState.processedBrews || 0) +
    (readinessText ? " | " + readinessText : "")
  );

  return {
    skipped: false,
    automatic: true,
    completed: completed,
    scannedThisRun: totalScannedThisRun,
    processedThisRun: totalProcessedThisRun,
    readsThisRun: readsThisRun,
    readsInWindow: finalReadsInWindow,
    budget: budget,
    quotaWindowKey: quota.key,
    styleReadiness: styleReadiness,
    state: finalState
  };
}
