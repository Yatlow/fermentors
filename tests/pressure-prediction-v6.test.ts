import assert from "node:assert/strict";
import test from "node:test";
import {
  buildV6OneActionCourses,
  countV6SuccessfulOneActionBatches,
  estimatePressureTargetV6,
} from "../src/SERVICES/cellering/pressurePredictionV6";
import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "../src/SERVICES/cellering/pressurePredictionV4";

function exposure(
  pressure: number,
  hours: number,
  temp: number,
): PressureV4Exposure {
  return {
    hoursSinceT0: hours,
    pressureHours: pressure * hours,
    temperatureHours: temp * hours,
    equilibriumDeltaBarHours: null,
    pressureMean: pressure,
    pressureMean24h: pressure,
    pressureMean48h: pressure,
    temperatureMean: temp,
    pressurePoints: 6,
    temperaturePoints: 6,
    coveredHours: hours,
    coverageRatio: 1,
  };
}

function state(
  carbonation: number,
  pressure: number,
  temp: number,
  hoursSinceT0 = 220,
): PressureV4DecisionState {
  return {
    carbonation,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0,
    exposure: exposure(pressure, hoursSinceT0, temp),
    cooling: {
      startDateTimeMs: Date.now() - 72 * 3600000,
      hoursSinceCooling: 72,
      startTemp: 20,
      currentTemp: temp,
      tempDropSinceCooling: 20 - temp,
      tempChange24h: temp > 1 ? -2 : -0.1,
      pressureMeanSinceCooling: pressure,
      pressureMean24h: pressure,
      pressureHoursSinceCooling: pressure * 72,
      equilibriumDeltaBarHoursSinceCooling: null,
      coverageRatio: 1,
      stillCooling: temp > 1,
    },
    carbonationTrend: null,
    currentCarbonationDateTimeMs: Date.now(),
    hoursSinceCurrentCarbonation: 0,
    postCarbonationExposure: null,
  };
}

function transition(
  index: number,
  kPerHour = 0.0015,
  pressure = 1.15,
  temp = 3,
  hoursSinceT0 = 220,
): PressureV4TransitionSample {
  return {
    batchId: `hist-k-${index}`,
    style: "ipa",
    startDateTimeMs: index * 100000,
    endDateTimeMs: index * 100000 + 48 * 3600000,
    durationHours: 48,
    startCarbonation: 2.25,
    endCarbonation: 2.36,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0,
    exposure: exposure(pressure, hoursSinceT0, temp),
    cooling: null,
    pressureMeanDuring: pressure,
    temperatureMeanDuring: temp,
    kPerHour,
    quality: "high",
  };
}

function actionSample(
  index: number,
  before: number,
  currentPressure: number,
  targetPressure: number,
  temp: number,
  outcome: number,
  hoursSinceT0 = 220,
): PressureV4Sample {
  return {
    batchId: `hist-action-${index}`,
    style: "ipa",
    t0: {
      index: 0,
      dateTimeMs: 0,
      source: "explicit_close",
      pressure: 1.6,
      previousPressure: 0,
    },
    actionDateTimeMs: index * 100000,
    actionDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
    carbonationBefore: before,
    currentPressure,
    targetPressure,
    currentTemp: temp,
    hoursSinceT0,
    exposure: exposure(currentPressure, hoursSinceT0, temp),
    intermediateDay1: null,
    primaryOutcome: {
      carbonation: outcome,
      dateTimeMs: index * 100000 + 48 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: outcome - before,
    actionPressureDelta: targetPressure - currentPressure,
    quality: "high",
  };
}

function passiveSample(
  index: number,
  before: number,
  pressure: number,
  temp: number,
  outcome: number,
  hoursSinceT0 = 300,
): PressureV4PassiveSample {
  return {
    batchId: `hist-passive-${index}`,
    style: "ipa",
    sampleDateTimeMs: index * 100000,
    sampleDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    carbonationBefore: before,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0,
    exposure: exposure(pressure, hoursSinceT0, temp),
    primaryOutcome: {
      carbonation: outcome,
      dateTimeMs: index * 100000 + 48 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: outcome - before,
    quality: "high",
  };
}

function successfulHistoricalBatches(
  actionPressure = 1.15,
  startCarbonation = 2.26,
  outcomeCarbonation = 2.45,
) {
  return Array.from({ length: 8 }, (_, index) => ({
    batchId: `raw-history-${index}`,
    measurements: [
      {
        id: `2026-08-${String(index + 1).padStart(2, "0")}_0800`,
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: `2026-08-${String(index + 2).padStart(2, "0")}_0900`,
        carbonation: startCarbonation + (index % 3) * 0.01,
        temp: 6.4 + (index % 3) * 0.2,
        pressure: 1.42 + (index % 2) * 0.03,
        notes: `הורדת לחץ ל${(actionPressure + (index % 3) * 0.01).toFixed(2)} bar`,
      },
      {
        id: `2026-08-${String(index + 5).padStart(2, "0")}_0900`,
        carbonation: outcomeCarbonation + (index % 2) * 0.01,
        temp: 0.7,
        pressure: 0.64 + (index % 3) * 0.02,
        notes: index % 2 === 0
          ? "הורדת שמרים, לחץ אחרי 0.60 bar"
          : "",
      },
    ],
  }));
}

test("V6 first check chooses the historical one-action course instead of forcing the 48h target", () => {
  const samples = Array.from({ length: 10 }, (_, index) =>
    actionSample(
      index,
      2.24 + (index % 3) * 0.02,
      1.40 + (index % 2) * 0.04,
      1.12 + (index % 4) * 0.02,
      5.5 + (index % 3) * 0.5,
      2.34 + (index % 3) * 0.02,
    )
  );
  const transitions = Array.from({ length: 10 }, (_, index) =>
    transition(index, 0.0014 + (index % 3) * 0.0001, 1.15, 4)
  );

  const estimate = estimatePressureTargetV6({
    samples,
    passiveSamples: [],
    transitions,
    state: state(2.26, 1.44, 6.8),
    measurements: [
      {
        id: "2026-09-16_0800",
        temp: 20.8,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-09-18_0900",
        carbonation: 2.26,
        temp: 6.8,
        pressure: 1.44,
      },
    ],
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    currentBatchId: "1590",
    historicalBatches: successfulHistoricalBatches(1.15, 2.26, 2.45),
  });

  assert.ok(estimate);
  assert.equal(estimate.version, 6);
  assert.ok(
    estimate.historicalPressurePrior !== null &&
      estimate.historicalPressurePrior >= 1.08 &&
      estimate.historicalPressurePrior <= 1.22,
    `historical one-action prior should remain around the successful 1.15 bar region, got ${estimate.historicalPressurePrior}`,
  );
  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure >= 0 &&
      estimate.targetPressure <= 1.9,
    "optimizer must return an operational pressure when it can make a recommendation",
  );
  assert.ok(
    estimate.supportCount >= 6,
    "historical pressure prior should be supported by distinct batches",
  );
});

test("V6 repeat check keeps pressure when the current tank trajectory is already on the terminal course", () => {
  const currentState = state(2.37, 1.10, 1.6, 300);
  currentState.carbonationTrend = {
    checksInPhase: 2,
    previousCarbonation: 2.26,
    previousDateTimeMs: Date.now() - 48 * 3600000,
    hoursSincePrevious: 48,
    deltaFromPrevious: 0.11,
    ratePerDay: 0.055,
    previousPressure: 1.15,
    previousTemp: 6.8,
  };

  const passive = Array.from({ length: 10 }, (_, index) =>
    passiveSample(
      index,
      2.34 + (index % 3) * 0.015,
      1.07 + (index % 4) * 0.02,
      1.2 + (index % 3) * 0.3,
      2.43 + (index % 3) * 0.01,
      300,
    )
  );

  const estimate = estimatePressureTargetV6({
    samples: [],
    passiveSamples: passive,
    transitions: Array.from({ length: 10 }, (_, index) =>
      transition(index, 0.0014 + (index % 3) * 0.0001, 1.1, 1.6, 300)
    ),
    state: currentState,
    measurements: [
      {
        id: "2026-09-16_0800",
        temp: 20.8,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-09-18_0900",
        carbonation: 2.26,
        temp: 6.8,
        pressure: 1.44,
        notes: "הורדת לחץ ל1.15 bar",
      },
      {
        id: "2026-09-20_0900",
        carbonation: 2.37,
        temp: 1.6,
        pressure: 1.10,
      },
    ],
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    currentBatchId: "1590",
    historicalBatches: successfulHistoricalBatches(1.12, 2.30, 2.45),
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "hold");
  assert.ok(
    estimate.targetPressure !== null &&
      Math.abs(estimate.targetPressure - 1.10) < 0.001,
    `expected HOLD at 1.10 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.currentBatchKPerHour !== null,
    "the second check should fit kinetics from the current batch interval",
  );
  assert.equal(estimate.operationalLossSource, "historical_one_action_courses");
  assert.ok(
    estimate.predictedAtTarget !== null,
    "HOLD should still expose a checkpoint forecast",
  );
});

test("V6 excludes the current batch from historical priors during replay", () => {
  const leakingSample = actionSample(
    1,
    2.26,
    1.44,
    1.40,
    6.8,
    2.45,
  );
  leakingSample.batchId = "1590";

  const estimate = estimatePressureTargetV6({
    samples: [leakingSample],
    passiveSamples: [],
    transitions: [],
    state: state(2.26, 1.44, 6.8),
    measurements: [
      {
        id: "2026-09-16_0800",
        temp: 20.8,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-09-18_0900",
        carbonation: 2.26,
        temp: 6.8,
        pressure: 1.44,
      },
    ],
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    currentBatchId: "1590",
  });

  assert.ok(estimate);
  assert.equal(estimate.supportCount, 0);
  assert.equal(estimate.historicalPressurePrior, null);
});


test("V6 never converts historical pressure actions into future operational loss", () => {
  const samples = Array.from({ length: 10 }, (_, index) =>
    actionSample(
      index,
      2.25,
      1.44,
      1.33,
      6.5,
      2.38,
    )
  );

  const estimate = estimatePressureTargetV6({
    samples,
    passiveSamples: [],
    transitions: Array.from({ length: 10 }, (_, index) =>
      transition(index, 0.0025, 1.30, 5.5)
    ),
    state: state(2.26, 1.44, 6.5),
    measurements: [
      {
        id: "2026-09-16_0800",
        temp: 20.8,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-09-18_0900",
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: "הורדת לחץ ל1.30 bar",
      },
    ],
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    currentBatchId: "1590",
  });

  assert.ok(estimate);
  assert.ok(
    estimate.historicalPressurePrior !== null &&
      estimate.historicalPressurePrior >= 1.30,
    "the historical pressure-action prior should still exist as decision evidence",
  );
  assert.equal(estimate.expectedPressureLossEvents, 1);
  assert.equal(estimate.operationalLossSource, "yeast_drop_fallback");
  assert.equal(
    estimate.expectedOperationalPressureLossBar,
    0.15,
    "historical setpoints such as 1.33 bar must not be reclassified as pressure loss",
  );
});

test("V6 uses measured yeast-drop loss only for a future identified yeast drop", () => {
  const estimate = estimatePressureTargetV6({
    samples: [],
    passiveSamples: [],
    transitions: Array.from({ length: 8 }, (_, index) =>
      transition(index, 0.002, 1.1, 3)
    ),
    state: state(2.30, 1.20, 3),
    measurements: [
      {
        id: "2026-09-15_0800",
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-09-16_0900",
        temp: 12,
        pressure: 1.40,
        notes: "הורדת שמרים חמה, לחץ אחרי 1.28 bar",
      },
      {
        id: "2026-09-18_0900",
        carbonation: 2.30,
        temp: 3,
        pressure: 1.20,
      },
    ],
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    currentBatchId: "1590",
  });

  assert.ok(estimate);
  assert.equal(estimate.expectedPressureLossEvents, 1);
  assert.equal(estimate.operationalLossSource, "observed_yeast_drops");
  assert.equal(estimate.expectedOperationalPressureLossBar, 0.12);
});


test("V6 does not label the failed first pressure action as a one-action success", () => {
  const badHistory = Array.from({ length: 8 }, (_, index) => ({
    batchId: `bad-course-${index}`,
    measurements: [
      {
        id: `2026-07-${String(index + 1).padStart(2, "0")}_0800`,
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: `2026-07-${String(index + 2).padStart(2, "0")}_0900`,
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: "הורדת לחץ ל1.30 bar",
      },
      {
        id: `2026-07-${String(index + 3).padStart(2, "0")}_0900`,
        carbonation: 2.35,
        temp: 2.0,
        pressure: 1.20,
        notes: "הורדת לחץ ל0.95 bar",
      },
      {
        id: `2026-07-${String(index + 5).padStart(2, "0")}_0900`,
        carbonation: 2.45,
        temp: 0.7,
        pressure: 0.65,
      },
    ],
  }));

  const courses = buildV6OneActionCourses({
    historicalBatches: badHistory,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.equal(
    courses.some((course) => Math.abs(course.actionPressure - 1.30) < 0.001),
    false,
    "the first 1.30 bar action required another correction and must not be a successful training action",
  );
  assert.equal(
    courses.some((course) => Math.abs(course.actionPressure - 0.95) < 0.001),
    true,
    "the later 0.95 bar decision can still be a valid one-action course from its own later state",
  );
});

test("V6 counts distinct batches that contain at least one valid one-action decision", () => {
  const successful = successfulHistoricalBatches(1.15, 2.26, 2.45);
  const corrected = Array.from({ length: 8 }, (_, index) => ({
    batchId: `corrected-${index}`,
    measurements: [
      {
        id: `2026-06-${String(index + 1).padStart(2, "0")}_0800`,
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: `2026-06-${String(index + 2).padStart(2, "0")}_0900`,
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: "הורדת לחץ ל1.30 bar",
      },
      {
        id: `2026-06-${String(index + 3).padStart(2, "0")}_0900`,
        carbonation: 2.35,
        temp: 2,
        pressure: 1.20,
        notes: "הורדת לחץ ל0.95 bar",
      },
      {
        id: `2026-06-${String(index + 5).padStart(2, "0")}_0900`,
        carbonation: 2.45,
        temp: 0.7,
        pressure: 0.65,
      },
    ],
  }));

  assert.equal(
    countV6SuccessfulOneActionBatches({
      historicalBatches: corrected,
      targetCarbonation: 2.45,
      targetToleranceVol: 0.03,
    }),
    8,
  );

  assert.equal(
    countV6SuccessfulOneActionBatches({
      historicalBatches: [...corrected, ...successful.slice(0, 5)],
      targetCarbonation: 2.45,
      targetToleranceVol: 0.03,
    }),
    13,
  );

  assert.equal(
    countV6SuccessfulOneActionBatches({
      historicalBatches: [...corrected, ...successful],
      targetCarbonation: 2.45,
      targetToleranceVol: 0.03,
    }),
    16,
  );
});
