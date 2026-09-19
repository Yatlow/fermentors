import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV4,
  type PressureV4DecisionState,
} from "../src/SERVICES/cellering/pressurePredictionV4Estimator";
import type {
  PressureV4CoolingState,
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
    cooling: overrides.cooling ?? null,
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
    cooling: null,
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
    cooling: null,
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
    cooling: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions,
    passiveSamples: [],
    samples: [],
    state,
    targetCarbonation: 2.45,
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
    cooling: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions,
    state,
    targetCarbonation: 2.45,
    maxPressure: 1.9,
  });

  assert.equal(estimate, null);
});


test("cooling trajectory selects different kinetics for early and late cold beer", () => {
  const earlyCooling: PressureV4CoolingState = {
    startDateTimeMs: 0,
    hoursSinceCooling: 24,
    startTemp: 14,
    currentTemp: 6.8,
    tempDropSinceCooling: 7.2,
    tempChange24h: -7.2,
    pressureMeanSinceCooling: 1.3,
    pressureMean24h: 1.3,
    pressureHoursSinceCooling: 31.2,
    equilibriumDeltaBarHoursSinceCooling: 12,
    coverageRatio: 1,
    stillCooling: true,
  };
  const lateCooling: PressureV4CoolingState = {
    startDateTimeMs: 0,
    hoursSinceCooling: 144,
    startTemp: 14,
    currentTemp: 1.5,
    tempDropSinceCooling: 12.5,
    tempChange24h: -0.1,
    pressureMeanSinceCooling: 0.95,
    pressureMean24h: 0.95,
    pressureHoursSinceCooling: 136.8,
    equilibriumDeltaBarHoursSinceCooling: 4,
    coverageRatio: 1,
    stillCooling: false,
  };

  const transitions = [
    ...Array.from({ length: 8 }, (_, index) =>
      transition(index, {
        kPerHour: 0.02,
        currentTemp: 6.8,
        temperatureMeanDuring: 5.5,
        exposure: exposure(1.3, 1.25, 0.4, 72),
        cooling: earlyCooling,
      }),
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      transition(index + 20, {
        kPerHour: 0.006,
        currentTemp: 1.5,
        temperatureMeanDuring: 1.5,
        exposure: exposure(0.95, 0.95, 0.05, 180),
        cooling: lateCooling,
      }),
    ),
  ];

  const earlyState: PressureV4DecisionState = {
    carbonation: 2.3,
    currentPressure: 1.25,
    currentTemp: 6.8,
    hoursSinceT0: 72,
    exposure: exposure(1.3, 1.25, 0.4, 72),
    cooling: earlyCooling,
  };
  const lateState: PressureV4DecisionState = {
    carbonation: 2.3,
    currentPressure: 0.95,
    currentTemp: 1.5,
    hoursSinceT0: 180,
    exposure: exposure(0.95, 0.95, 0.05, 180),
    cooling: lateCooling,
  };

  const early = estimatePressureTargetV4({
    transitions,
    state: earlyState,
    targetCarbonation: 2.45,
    coldReferenceTemperature: 1.5,
  });
  const late = estimatePressureTargetV4({
    transitions,
    state: lateState,
    targetCarbonation: 2.45,
    coldReferenceTemperature: 1.5,
  });

  assert.ok(early);
  assert.ok(late);
  assert.ok(
    early.kPerHour > late.kPerHour,
    "early cooling should select faster historical absorption than late cold beer",
  );
});
