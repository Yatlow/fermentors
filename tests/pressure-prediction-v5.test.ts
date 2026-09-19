import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV5,
  learnPressureResponseV5,
} from "../src/SERVICES/cellering/pressurePredictionV5";
import { equilibriumPressureBar } from "../src/SERVICES/cellering/pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
} from "../src/SERVICES/cellering/pressurePredictionV4";

function exposure(pressure: number, hours = 300): PressureV4Exposure {
  return {
    hoursSinceT0: hours,
    pressureHours: pressure * hours,
    temperatureHours: hours,
    equilibriumDeltaBarHours: null,
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
  actionDelta: number,
  slope = 0.67,
): PressureV4Sample {
  const currentPressure = 0.7;
  const carbonationBefore = 2.3;
  const currentTemp = 1;
  const targetPressure = currentPressure + actionDelta;
  const equilibrium = equilibriumPressureBar(
    currentTemp,
    carbonationBefore,
  );
  if (equilibrium === null) throw new Error("invalid equilibrium");
  const pressureDistance = targetPressure - equilibrium;
  const carbonationDelta = slope * pressureDistance;
  return {
    batchId: `a-${index}`,
    style: "test",
    t0: {
      index: 0,
      dateTimeMs: 0,
      source: "explicit_close",
      pressure: currentPressure,
      previousPressure: 0,
    },
    actionDateTimeMs: index * 100000,
    actionDate: "2026-09-01",
    carbonationBefore,
    currentPressure,
    targetPressure,
    currentTemp,
    hoursSinceT0: 300,
    exposure: exposure(currentPressure),
    intermediateDay1: null,
    primaryOutcome: {
      carbonation: carbonationBefore + carbonationDelta,
      dateTimeMs: index * 100000 + 48 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta,
    actionPressureDelta: actionDelta,
    quality: "high",
  };
}

function passiveSample(
  index: number,
  slope = 0.67,
): PressureV4PassiveSample {
  const carbonationBefore = 2.3;
  const pressure = 0.7;
  const currentTemp = 1;
  const equilibrium = equilibriumPressureBar(
    currentTemp,
    carbonationBefore,
  );
  if (equilibrium === null) throw new Error("invalid equilibrium");
  const drift = slope * (pressure - equilibrium);
  return {
    batchId: `p-${index}`,
    style: "test",
    sampleDateTimeMs: index * 100000,
    sampleDate: "2026-09-01",
    carbonationBefore,
    currentPressure: pressure,
    currentTemp,
    hoursSinceT0: 300,
    exposure: exposure(pressure),
    primaryOutcome: {
      carbonation: carbonationBefore + drift,
      dateTimeMs: index * 100000 + 48 * 3600000,
      calendarDaysAfterAction: 2,
    },
    carbonationDelta: drift,
    quality: "high",
  };
}

test("V5 learns vol/bar directly from historical pressure actions", () => {
  const s = state(2.3, 0.7);
  const actionDeltas = [-0.2, -0.1, 0.1, 0.2, 0.35, 0.5];
  const samples = Array.from({ length: 18 }, (_, index) =>
    actionSample(index, actionDeltas[index % actionDeltas.length], 0.67)
  );
  const passiveSamples = Array.from({ length: 8 }, (_, index) =>
    passiveSample(index, 0.67)
  );

  const learned = learnPressureResponseV5({
    samples,
    passiveSamples,
    state: s,
  });

  assert.equal(learned.source, "learned");
  assert.ok(
    Math.abs(learned.volPerBar - 0.67) <= 0.03,
    `expected about 0.67 vol/bar, got ${learned.volPerBar}`,
  );
  assert.ok(learned.supportCount >= 8);
});

test("V5 first carbonation counts stored head pressure at the cold destination", () => {
  const s = state(2.26, 1.37, 4.5);

  const estimate = estimatePressureTargetV5({
    state: s,
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.7,
    firstCarbonation: true,
  });

  assert.ok(estimate);
  assert.equal(estimate.mode, "first_cooling");
  assert.equal(estimate.responseSource, "heuristic");
  assert.equal(estimate.forecastTemperature, 0.7);
  assert.ok(
    estimate.pressureDistanceFromEquilibrium > 0.5,
    `expected substantial stored pressure above equilibrium, got ${estimate.pressureDistanceFromEquilibrium}`,
  );
  assert.ok(
    estimate.predictedWithoutChange > 2.45,
    `unchanged 1.37 bar should already overshoot the target after cooling, got ${estimate.predictedWithoutChange}`,
  );
  assert.equal(
    estimate.action,
    "lower",
    "first carbonation with substantial stored pressure must lower, not raise",
  );
  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure < s.currentPressure,
  );
  assert.ok(
    estimate.predictedAtTarget !== null &&
      Math.abs(estimate.predictedAtTarget - 2.45) <= 0.02,
  );
});

test("V5 uses the same learned response for first and subsequent checks", () => {
  const actionDeltas = [-0.2, -0.1, 0.1, 0.2, 0.35, 0.5];
  const samples = Array.from({ length: 18 }, (_, index) =>
    actionSample(index, actionDeltas[index % actionDeltas.length], 0.55)
  );
  const passiveSamples = Array.from({ length: 8 }, (_, index) =>
    passiveSample(index, 0.55)
  );

  const stable = estimatePressureTargetV5({
    samples,
    passiveSamples,
    state: state(2.3, 0.8, 1),
    targetCarbonation: 2.4,
    firstCarbonation: false,
  });
  const first = estimatePressureTargetV5({
    samples,
    passiveSamples,
    state: state(2.3, 0.8, 4.5),
    targetCarbonation: 2.4,
    coldReferenceTemperature: 1,
    firstCarbonation: true,
  });

  assert.ok(stable);
  assert.ok(first);
  assert.equal(stable.responseSource, "learned");
  assert.equal(first.responseSource, "learned");
  assert.ok(Math.abs(stable.volPerBar - first.volPerBar) <= 0.001);
});

test("V5 pressure distance is symmetric around equilibrium", () => {
  const high = estimatePressureTargetV5({
    state: state(2.4, 1.0, 1),
    targetCarbonation: 2.4,
  });
  const low = estimatePressureTargetV5({
    state: state(2.4, 0.1, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(high);
  assert.ok(low);
  assert.ok(high.pressureDistanceFromEquilibrium > 0);
  assert.ok(high.predictedWithoutChange > 2.4);
  assert.ok(low.pressureDistanceFromEquilibrium < 0);
  assert.ok(low.predictedWithoutChange < 2.4);
});

test("V5 recognizes <2.15 as bottom-carbonation edge case", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.14, 0.6, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.edgeCase, "bottom_carbonation");
  assert.equal(estimate.targetPressure, null);
  assert.equal(estimate.action, "edge_case");
});

test("V5 recognizes when target requires below-zero gauge pressure", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.8, 0.2, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.edgeCase, "venting_below_zero");
  assert.ok(
    estimate.rawTargetPressure !== null &&
      estimate.rawTargetPressure < 0,
  );
});

test("V5 falls back transparently to the operational 0.67 vol/bar heuristic", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.3, 0.7, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.responseSource, "heuristic");
  assert.equal(estimate.volPerBar, 0.67);
});
