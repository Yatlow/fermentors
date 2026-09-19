import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV4,
  type PressureV4DecisionState,
} from "../src/SERVICES/cellering/pressurePredictionV4Estimator";
import type {
  PressureV4Exposure,
  PressureV4TransitionSample,
} from "../src/SERVICES/cellering/pressurePredictionV4";
import {
  equilibriumPressureBar,
  evolveCarbonation,
} from "../src/SERVICES/cellering/pressureCarbonationPhysics";

function exposure(
  mean24: number,
  mean48: number,
  eqRate: number,
  hours = 72,
): PressureV4Exposure {
  return {
    hoursSinceT0: hours,
    pressureHours: mean48 * hours,
    temperatureHours: 6 * hours,
    equilibriumDeltaBarHours: eqRate * hours,
    pressureMean: mean48,
    pressureMean24h: mean24,
    pressureMean48h: mean48,
    temperatureMean: 6,
    pressurePoints: 6,
    temperaturePoints: 6,
    coveredHours: hours,
    coverageRatio: 1,
  };
}

function transition(
  index: number,
  overrides: Partial<PressureV4TransitionSample> = {},
): PressureV4TransitionSample {
  const startCarbonation = overrides.startCarbonation ?? 2.3;
  const pressureMeanDuring = overrides.pressureMeanDuring ?? 1.0;
  const temperatureMeanDuring = overrides.temperatureMeanDuring ?? 6.8;
  const durationHours = overrides.durationHours ?? 48;
  const kPerHour = overrides.kPerHour ?? 0.015;
  const predicted = evolveCarbonation({
    carbonation: startCarbonation,
    pressureBar: pressureMeanDuring,
    temperatureC: temperatureMeanDuring,
    kPerHour,
    hours: durationHours,
  });
  if (predicted === null) throw new Error("invalid test transition");

  return {
    batchId: `b-${index}`,
    style: "ipa",
    startDateTimeMs: index * 10_000_000,
    endDateTimeMs: index * 10_000_000 + durationHours * 3600000,
    durationHours,
    startCarbonation,
    endCarbonation: predicted,
    currentPressure: overrides.currentPressure ?? pressureMeanDuring,
    currentTemp: overrides.currentTemp ?? temperatureMeanDuring,
    hoursSinceT0: overrides.hoursSinceT0 ?? 72,
    exposure: overrides.exposure ?? exposure(1.3, 1.25, 0.4),
    pressureMeanDuring,
    temperatureMeanDuring,
    kPerHour,
    quality: overrides.quality ?? "high",
    ...overrides,
  };
}

test("standard beer equilibrium is about 0.96 bar for 2.45 vol at 6.8C", () => {
  const pressure = equilibriumPressureBar(6.8, 2.45);
  assert.ok(pressure !== null);
  assert.ok(pressure > 0.93 && pressure < 0.99);
});

test("kinetic V4 recommends about 1.1 bar from 2.25 at 1.44 bar with active absorption", () => {
  const transitions = Array.from({ length: 12 }, (_, index) =>
    transition(index, {
      startCarbonation: 2.25 + (index % 3) * 0.01,
      kPerHour: 0.014 + (index % 4) * 0.0005,
      hoursSinceT0: 60 + (index % 4) * 12,
      exposure: exposure(1.36, 1.31, 0.46),
      currentPressure: 1.4,
      currentTemp: 6.8,
      pressureMeanDuring: 1.05 + (index % 3) * 0.05,
      temperatureMeanDuring: 6.8,
    }),
  );

  const state: PressureV4DecisionState = {
    carbonation: 2.25,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 72,
    exposure: exposure(1.36, 1.31, 0.46),
  };

  const estimate = estimatePressureTargetV4({
    transitions,
    state,
    targetCarbonation: 2.45,
  });

  assert.ok(estimate);
  assert.ok(estimate.targetPressure >= 1.05 && estimate.targetPressure <= 1.15);
  assert.ok(estimate.predictedCarbonationWithoutChange > 2.55);
  assert.ok(Math.abs(estimate.predictedCarbonation - 2.45) <= 0.03);
});

test("kinetic V4 raises roughly toward equilibrium from 2.38 at 0.8 bar", () => {
  const transitions = Array.from({ length: 12 }, (_, index) =>
    transition(index, {
      startCarbonation: 2.36 + (index % 4) * 0.01,
      kPerHour: 0.014 + (index % 4) * 0.0005,
      hoursSinceT0: 72 + (index % 4) * 12,
      exposure: exposure(0.82, 0.8, 0.01, 96),
      currentPressure: 0.8,
      currentTemp: 6.8,
      pressureMeanDuring: 0.9 + (index % 4) * 0.05,
      temperatureMeanDuring: 6.8,
    }),
  );

  const state: PressureV4DecisionState = {
    carbonation: 2.38,
    currentPressure: 0.8,
    currentTemp: 6.8,
    hoursSinceT0: 96,
    exposure: exposure(0.82, 0.8, 0.01, 96),
  };

  const estimate = estimatePressureTargetV4({
    transitions,
    state,
    targetCarbonation: 2.45,
  });

  assert.ok(estimate);
  assert.ok(estimate.targetPressure > state.currentPressure);
  assert.ok(estimate.targetPressure >= 0.95 && estimate.targetPressure <= 1.05);
  assert.ok(Math.abs(estimate.predictedCarbonation - 2.45) <= 0.03);
});

test("later carbonation tests use the same calculator and do not need passive samples", () => {
  const transitions = Array.from({ length: 10 }, (_, index) =>
    transition(index, {
      startCarbonation: 2.35 + (index % 4) * 0.015,
      kPerHour: 0.012 + (index % 4) * 0.001,
      hoursSinceT0: 120 + (index % 4) * 24,
      exposure: exposure(0.95, 0.9, 0.08, 144),
      currentPressure: 0.9,
      currentTemp: 5,
      pressureMeanDuring: 1.0,
      temperatureMeanDuring: 5,
    }),
  );

  const state: PressureV4DecisionState = {
    carbonation: 2.36,
    currentPressure: 0.9,
    currentTemp: 5,
    hoursSinceT0: 144,
    exposure: exposure(0.95, 0.9, 0.08, 144),
  };

  const estimate = estimatePressureTargetV4({
    transitions,
    passiveSamples: [],
    samples: [],
    state,
    targetCarbonation: 2.45,
    firstCarbonation: false,
  });

  assert.ok(estimate);
  assert.ok(estimate.supportCount >= 4);
});

test("V4 abstains when the allowed pressure range cannot reach target in 48h", () => {
  const transitions = Array.from({ length: 10 }, (_, index) =>
    transition(index, {
      startCarbonation: 2.0,
      kPerHour: 0.001,
      exposure: exposure(1.0, 1.0, 0.1),
      currentPressure: 1.0,
      currentTemp: 6.8,
      pressureMeanDuring: 1.0,
      temperatureMeanDuring: 6.8,
    }),
  );

  const state: PressureV4DecisionState = {
    carbonation: 2.0,
    currentPressure: 1.0,
    currentTemp: 6.8,
    hoursSinceT0: 72,
    exposure: exposure(1.0, 1.0, 0.1),
  };

  const estimate = estimatePressureTargetV4({
    transitions,
    state,
    targetCarbonation: 2.45,
    maxPressure: 1.9,
  });

  assert.equal(estimate, null);
});
