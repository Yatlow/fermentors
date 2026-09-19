import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPressureV5TrainingPoints,
  estimatePressureTargetV5,
  learnPressureV5Alpha,
} from "../src/SERVICES/cellering/pressurePredictionV5";
import {
  equilibriumCarbonationVolumes,
} from "../src/SERVICES/cellering/pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "../src/SERVICES/cellering/pressurePredictionV4";

function exposure(pressure: number, hours = 300): PressureV4Exposure {
  return {
    hoursSinceT0: hours,
    pressureHours: pressure * hours,
    temperatureHours: 1 * hours,
    equilibriumDeltaBarHours: 0,
    pressureMean: pressure,
    pressureMean24h: pressure,
    pressureMean48h: pressure,
    temperatureMean: 1,
    pressurePoints: 8,
    temperaturePoints: 8,
    coveredHours: hours,
    coverageRatio: 1,
  };
}

function state(
  carbonation: number,
  pressure: number,
  temp = 1,
): PressureV4DecisionState {
  return {
    carbonation,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0: 300,
    exposure: exposure(pressure),
    cooling: null,
    carbonationTrend: null,
  };
}

function actionSample(
  index: number,
  pressure: number,
  alpha = 0.5,
  startCarbonation = 2.3,
  temp = 1,
): PressureV4Sample {
  const eq = equilibriumCarbonationVolumes(temp, pressure);
  if (eq === null) throw new Error("invalid equilibrium");
  const delta = alpha * (eq - startCarbonation);
  return {
    batchId: `a-${index}`,
    style: "test",
    t0: {
      index: 0,
      dateTimeMs: 0,
      source: "explicit_close",
      pressure: 0.5,
      previousPressure: 0,
    },
    actionDateTimeMs: index * 100000,
    actionDate: "2026-09-01",
    carbonationBefore: startCarbonation,
    currentPressure: 0.5,
    targetPressure: pressure,
    currentTemp: temp,
    hoursSinceT0: 300,
    exposure: exposure(0.5),
    intermediateDay1: null,
    primaryOutcome: {
      carbonation: startCarbonation + delta,
      dateTimeMs: index * 100000 + 48 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: delta,
    actionPressureDelta: pressure - 0.5,
    quality: "high",
  };
}

function passiveSample(
  index: number,
  pressure: number,
  alpha = 0.5,
  startCarbonation = 2.3,
  temp = 1,
): PressureV4PassiveSample {
  const eq = equilibriumCarbonationVolumes(temp, pressure);
  if (eq === null) throw new Error("invalid equilibrium");
  const delta = alpha * (eq - startCarbonation);
  return {
    batchId: `p-${index}`,
    style: "test",
    sampleDateTimeMs: index * 100000,
    sampleDate: "2026-09-01",
    carbonationBefore: startCarbonation,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0: 300,
    exposure: exposure(pressure),
    primaryOutcome: {
      carbonation: startCarbonation + delta,
      dateTimeMs: index * 100000 + 48 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: delta,
    quality: "high",
  };
}

function transition(
  index: number,
  pressure: number,
  alpha48 = 0.4,
  startCarbonation = 2.3,
  temp = 1,
  durationHours = 36,
): PressureV4TransitionSample {
  const eq = equilibriumCarbonationVolumes(temp, pressure);
  if (eq === null) throw new Error("invalid equilibrium");
  const k = -Math.log(1 - alpha48) / 48;
  const alphaDuration = 1 - Math.exp(-k * durationHours);
  const endCarbonation =
    startCarbonation + alphaDuration * (eq - startCarbonation);

  return {
    batchId: `t-${index}`,
    style: "test",
    startDateTimeMs: index * 100000,
    endDateTimeMs: index * 100000 + durationHours * 3600000,
    durationHours,
    startCarbonation,
    endCarbonation,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0: 300,
    exposure: exposure(pressure),
    cooling: null,
    pressureMeanDuring: pressure,
    temperatureMeanDuring: temp,
    kPerHour: k,
    quality: "high",
  };
}

test("V5 learns the 48h fraction of distance to equilibrium from existing action/passive data", () => {
  const s = state(2.3, 0.7);
  const pressures = [0.6, 0.75, 0.9, 1.05];
  const samples = Array.from({ length: 8 }, (_, index) =>
    actionSample(index, pressures[index % pressures.length], 0.5)
  );
  const passiveSamples = Array.from({ length: 8 }, (_, index) =>
    passiveSample(index, pressures[index % pressures.length], 0.5)
  );

  const points = buildPressureV5TrainingPoints({
    samples,
    passiveSamples,
    state: s,
  });
  const learned = learnPressureV5Alpha(points);

  assert.equal(learned.source, "learned");
  assert.ok(learned.supportCount >= 8);
  assert.ok(
    Math.abs(learned.alpha48 - 0.5) <= 0.03,
    `expected alpha around 0.50, got ${learned.alpha48}`,
  );
});

test("V5 inverts the same equilibrium equation to choose a pressure that reaches target", () => {
  const s = state(2.3, 0.7);
  const samples = Array.from({ length: 12 }, (_, index) =>
    actionSample(index, 0.6 + (index % 4) * 0.15, 0.5)
  );
  const passiveSamples = Array.from({ length: 8 }, (_, index) =>
    passiveSample(index, 0.55 + (index % 4) * 0.15, 0.5)
  );

  const estimate = estimatePressureTargetV5({
    samples,
    passiveSamples,
    state: s,
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.alphaSource, "learned");
  assert.equal(estimate.edgeCase, null);
  assert.ok(estimate.targetPressure !== null);
  assert.ok(
    estimate.predictedAtTarget !== null &&
      Math.abs(estimate.predictedAtTarget - 2.4) <= 0.015,
    `target pressure should land near 2.40, got ${estimate.predictedAtTarget}`,
  );
});

test("V5 preserves the sign of the physical driving force", () => {
  const highPressure = estimatePressureTargetV5({
    state: state(2.4, 1.0),
    targetCarbonation: 2.4,
  });
  const lowPressure = estimatePressureTargetV5({
    state: state(2.4, 0.2),
    targetCarbonation: 2.4,
  });

  assert.ok(highPressure);
  assert.ok(lowPressure);
  assert.ok(highPressure.drivingForceVol > 0);
  assert.ok(highPressure.predictedWithoutChange > 2.4);
  assert.ok(lowPressure.drivingForceVol < 0);
  assert.ok(lowPressure.predictedWithoutChange < 2.4);
});

test("V5 recognizes <2.15 as bottom-carbonation edge case without calculating the treatment", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.14, 0.6),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.edgeCase, "bottom_carbonation");
  assert.equal(estimate.targetPressure, null);
  assert.equal(estimate.action, "edge_case");
});

test("V5 recognizes when the inverted target would require below-zero gauge pressure", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.8, 0.7),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.edgeCase, "venting_below_zero");
  assert.ok(
    estimate.rawTargetPressure !== null && estimate.rawTargetPressure < 0,
  );
  assert.equal(estimate.targetPressure, null);
});

test("V5 can learn alpha from existing transitions when 48h samples are sparse", () => {
  const s = state(2.3, 0.7);
  const transitions = Array.from({ length: 8 }, (_, index) =>
    transition(index, 0.6 + (index % 4) * 0.15, 0.4)
  );

  const estimate = estimatePressureTargetV5({
    transitions,
    state: s,
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.alphaSource, "learned");
  assert.ok(
    Math.abs(estimate.alpha48 - 0.4) <= 0.04,
    `expected alpha around 0.40 from transitions, got ${estimate.alpha48}`,
  );
});
