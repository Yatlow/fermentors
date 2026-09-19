import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV4,
  type PressureV4DecisionState,
} from "../src/SERVICES/cellering/pressurePredictionV4Estimator";
import type {
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
} from "../src/SERVICES/cellering/pressurePredictionV4";

function exposure(
  mean24: number,
  mean48: number,
  eqRate: number,
): PressureV4Exposure {
  return {
    hoursSinceT0: 72,
    pressureHours: mean48 * 72,
    temperatureHours: 4 * 72,
    equilibriumDeltaBarHours: eqRate * 72,
    pressureMean: mean48,
    pressureMean24h: mean24,
    pressureMean48h: mean48,
    temperatureMean: 4,
    pressurePoints: 6,
    temperaturePoints: 6,
    coveredHours: 72,
    coverageRatio: 1,
  };
}

function passiveSample(
  delta: number,
  overrides: Partial<PressureV4PassiveSample> = {},
): PressureV4PassiveSample {
  return {
    batchId: "passive",
    style: "ipa",
    sampleDateTimeMs: 72 * 3600000,
    sampleDate: "2026-09-10",
    carbonationBefore: 2.26,
    currentPressure: 1.4,
    currentTemp: 6,
    hoursSinceT0: 72,
    exposure: exposure(1.35, 1.3, 0.45),
    primaryOutcome: {
      carbonation: 2.26 + delta,
      dateTimeMs: 120 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: delta,
    quality: "high",
    ...overrides,
  };
}

function sample(
  targetPressure: number,
  delta: number,
  overrides: Partial<PressureV4Sample> = {},
): PressureV4Sample {
  return {
    batchId: "x",
    style: "ipa",
    t0: {
      index: 0,
      dateTimeMs: 0,
      source: "explicit_close",
      pressure: 0.8,
      previousPressure: 0,
    },
    actionDateTimeMs: 72 * 3600000,
    actionDate: "2026-09-10",
    carbonationBefore: 2.26,
    currentPressure: 1.4,
    targetPressure,
    currentTemp: 6,
    hoursSinceT0: 72,
    exposure: exposure(1.35, 1.3, 0.45),
    intermediateDay1: null,
    primaryOutcome: {
      carbonation: 2.26 + delta,
      dateTimeMs: 120 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: delta,
    actionPressureDelta: targetPressure - 1.4,
    quality: "high",
    ...overrides,
  };
}

test("V4 can recommend lowering pressure while carbonation is still below target", () => {
  const samples: PressureV4Sample[] = [
    sample(0.8, 0.11),
    sample(0.9, 0.14),
    sample(1.0, 0.17),
    sample(1.1, 0.19),
    sample(1.2, 0.22),
    sample(1.3, 0.24),
    sample(1.4, 0.27),
    sample(1.5, 0.29),
  ];

  const state: PressureV4DecisionState = {
    carbonation: 2.26,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 72,
    exposure: exposure(1.36, 1.31, 0.46),
  };

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples: Array.from({ length: 12 }, () => passiveSample(0.27)),
    state,
    targetCarbonation: 2.45,
  });

  assert.ok(estimate);
  assert.ok(
    estimate.targetPressure < state.currentPressure,
    "existing CO2 exposure can make a lower pressure target appropriate",
  );
  assert.ok(
    estimate.targetPressure >= 1.0 && estimate.targetPressure <= 1.2,
    "the operator-like case should land near the expected ~1.1 bar range",
  );
  assert.ok(
    estimate.predictedCarbonationWithoutChange > state.carbonation,
    "the model should explicitly represent continued absorption even with no pressure change",
  );
  assert.ok(Math.abs(estimate.predictedCarbonation - 2.45) <= 0.03);
});

test("V4 predicts higher carbonation for higher ordinary pressure targets", () => {
  const samples: PressureV4Sample[] = [
    sample(0.6, -0.02),
    sample(0.8, 0.02),
    sample(1.0, 0.06),
    sample(1.2, 0.10),
    sample(1.4, 0.14),
    sample(1.6, 0.18),
  ];

  const state: PressureV4DecisionState = {
    carbonation: 2.4,
    currentPressure: 0.8,
    currentTemp: 2,
    hoursSinceT0: 120,
    exposure: exposure(0.8, 0.8, 0),
  };

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples: Array.from({ length: 12 }, () => passiveSample(0.05)),
    state,
    targetCarbonation: 2.45,
  });

  assert.ok(estimate);
  const low = estimate.candidates.find((candidate) => candidate.targetPressure === 0.8);
  const high = estimate.candidates.find((candidate) => candidate.targetPressure === 1.4);
  assert.ok(low);
  assert.ok(high);
  assert.ok(high.predictedCarbonation >= low.predictedCarbonation);
});

test("V4 stays within absolute operational pressure bounds", () => {
  const samples: PressureV4Sample[] = [
    sample(1.4, 0.02),
    sample(1.5, 0.03),
    sample(1.6, 0.04),
    sample(1.7, 0.05),
    sample(1.8, 0.06),
    sample(1.9, 0.07),
  ];

  const state: PressureV4DecisionState = {
    carbonation: 2.0,
    currentPressure: 1.4,
    currentTemp: 2,
    hoursSinceT0: 72,
    exposure: exposure(1.3, 1.2, 0.3),
  };

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples: Array.from({ length: 12 }, () => passiveSample(0.02)),
    state,
    targetCarbonation: 2.45,
  });

  assert.equal(
    estimate,
    null,
    "when even the 1.9 bar operational boundary stays materially below target, V4 should abstain instead of calling the boundary a recommendation",
  );
});



test("first carbonation behavior follows pressure history rather than a fixed prior", () => {
  const highExposureSamples: PressureV4Sample[] = [
    sample(0.9, 0.16, {
      currentPressure: 1.4,
      actionPressureDelta: -0.5,
      exposure: exposure(1.35, 1.3, 0.45),
    }),
    sample(1.0, 0.18, {
      currentPressure: 1.4,
      actionPressureDelta: -0.4,
      exposure: exposure(1.35, 1.3, 0.45),
    }),
    sample(1.1, 0.20, {
      currentPressure: 1.4,
      actionPressureDelta: -0.3,
      exposure: exposure(1.35, 1.3, 0.45),
    }),
    sample(1.2, 0.22, {
      currentPressure: 1.4,
      actionPressureDelta: -0.2,
      exposure: exposure(1.35, 1.3, 0.45),
    }),
    sample(1.3, 0.24, {
      currentPressure: 1.4,
      actionPressureDelta: -0.1,
      exposure: exposure(1.35, 1.3, 0.45),
    }),
    sample(1.4, 0.26, {
      currentPressure: 1.4,
      actionPressureDelta: 0,
      exposure: exposure(1.35, 1.3, 0.45),
    }),
  ];

  const lowExposureSamples: PressureV4Sample[] = [
    sample(0.8, 0.01, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(0.9, 0.03, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.1,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.0, 0.05, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.2,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.1, 0.07, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.3,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.2, 0.09, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.4,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.3, 0.11, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.5,
      exposure: exposure(0.8, 0.8, 0),
    }),
  ];

  const highExposureState: PressureV4DecisionState = {
    carbonation: 2.25,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 72,
    exposure: exposure(1.36, 1.31, 0.46),
  };

  const lowExposureState: PressureV4DecisionState = {
    carbonation: 2.38,
    currentPressure: 0.8,
    currentTemp: 6.8,
    hoursSinceT0: 72,
    exposure: exposure(0.8, 0.8, 0),
  };

  const lower = estimatePressureTargetV4({
    samples: highExposureSamples,
    passiveSamples: [],
    state: highExposureState,
    targetCarbonation: 2.45,
    firstCarbonation: true,
    equilibriumPressure: 0.79,
  });
  const raise = estimatePressureTargetV4({
    samples: lowExposureSamples,
    passiveSamples: [],
    state: lowExposureState,
    targetCarbonation: 2.45,
    firstCarbonation: true,
    equilibriumPressure: 0.79,
  });

  assert.ok(lower);
  assert.ok(raise);
  assert.ok(
    lower.targetPressure < highExposureState.currentPressure,
    "high prior pressure exposure should support lowering pressure",
  );
  assert.ok(
    raise.targetPressure > lowExposureState.currentPressure,
    "low prior pressure exposure with a remaining carb deficit should support raising pressure",
  );
});

test("non-first carbonation can recommend pressure change without separate passive samples", () => {
  const samples: PressureV4Sample[] = [
    sample(0.8, 0.01, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(0.9, 0.03, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.1,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.0, 0.05, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.2,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.1, 0.07, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.3,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.2, 0.09, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.4,
      exposure: exposure(0.8, 0.8, 0),
    }),
    sample(1.3, 0.11, {
      carbonationBefore: 2.38,
      currentPressure: 0.8,
      actionPressureDelta: 0.5,
      exposure: exposure(0.8, 0.8, 0),
    }),
  ];

  const state: PressureV4DecisionState = {
    carbonation: 2.38,
    currentPressure: 0.8,
    currentTemp: 6.8,
    hoursSinceT0: 120,
    exposure: exposure(0.8, 0.8, 0),
  };

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples: [],
    state,
    targetCarbonation: 2.45,
    firstCarbonation: false,
    equilibriumPressure: 0.79,
  });

  assert.ok(estimate);
  assert.ok(estimate.targetPressure > state.currentPressure);
  assert.ok(Math.abs(estimate.predictedCarbonation - 2.45) <= 0.03);
});
