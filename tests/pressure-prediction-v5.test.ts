import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV5,
} from "../src/SERVICES/cellering/pressurePredictionV5";
import {
  equilibriumPressureBar,
} from "../src/SERVICES/cellering/pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4TransitionSample,
} from "../src/SERVICES/cellering/pressurePredictionV4";

function exposure(
  pressure: number,
  hours = 300,
  temp = 1,
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
  ageHours = 0,
): PressureV4DecisionState {
  return {
    carbonation,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0: 300,
    exposure: exposure(pressure, 300, temp),
    cooling: null,
    carbonationTrend: null,
    currentCarbonationDateTimeMs:
      ageHours > 0 ? Date.now() - ageHours * 3600000 : Date.now(),
    hoursSinceCurrentCarbonation: ageHours,
    postCarbonationExposure:
      ageHours > 0
        ? exposure(pressure, ageHours, temp)
        : null,
  };
}

function transition(
  index: number,
  kPerHour: number,
  quality: "low" | "medium" | "high" = "high",
): PressureV4TransitionSample {
  return {
    batchId: `t-${index}`,
    style: "test",
    startDateTimeMs: index * 100000,
    endDateTimeMs: index * 100000 + 48 * 3600000,
    durationHours: 48,
    startCarbonation: 2.28 + (index % 3) * 0.03,
    endCarbonation: 2.4,
    currentPressure: 0.9 + (index % 4) * 0.1,
    currentTemp: 1 + (index % 2) * 0.3,
    hoursSinceT0: 200,
    exposure: exposure(1, 200, 1),
    cooling: null,
    pressureMeanDuring: 1,
    temperatureMeanDuring: 1,
    kPerHour,
    quality,
  };
}

test("V5 operational fallback corresponds to roughly 0.67 vol/bar over 48h", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.3, 0.8, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.kSource, "heuristic");
  assert.ok(
    estimate.effectiveVolPerBar48h >= 0.55 &&
      estimate.effectiveVolPerBar48h <= 0.8,
    `expected operational fallback near 0.67 vol/bar, got ${estimate.effectiveVolPerBar48h}`,
  );
});

test("V5 learns a plausible transfer rate from transition history", () => {
  const transitions = Array.from(
    { length: 12 },
    (_, index) => transition(index, 0.012 + (index % 3) * 0.001),
  );

  const estimate = estimatePressureTargetV5({
    transitions,
    state: state(2.3, 0.8, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.kSource, "learned");
  assert.ok(estimate.supportCount >= 12);
  assert.ok(
    estimate.kPerHour >= 0.008 &&
      estimate.kPerHour <= 0.02,
    `unexpected learned k ${estimate.kPerHour}`,
  );
});

test("V5 rejects the old absurdly slow k instead of letting it force huge pressure", () => {
  const transitions = Array.from(
    { length: 12 },
    (_, index) => transition(index, 0.00007),
  );

  const estimate = estimatePressureTargetV5({
    transitions,
    state: state(2.26, 1.44, 6.8),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(estimate);
  assert.equal(estimate.kSource, "guarded");
  assert.ok(
    estimate.rawLearnedKPerHour !== null &&
      estimate.rawLearnedKPerHour < 0.001,
  );
  assert.ok(
    estimate.effectiveVolPerBar48h > 0.5,
    "guarded model must fall back to the operational response instead of the near-zero historical k",
  );
});

test("V5 first carbonation with stored head pressure recommends lower pressure", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.26, 1.44, 6.8),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(estimate);
  assert.equal(estimate.mode, "first_cooling");
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure < 1.44,
    `expected lower than 1.44 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.predictedAtTarget !== null &&
      Math.abs(estimate.predictedAtTarget - 2.45) <= 0.02,
  );
});

test("V5 first-cooling setpoint uses the learned 48h response above TARGET equilibrium", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.00097),
  );

  const estimate = estimatePressureTargetV5({
    transitions,
    state: state(2.25, 1.37, 4.5),
    targetCarbonation: 2.4,
    coldReferenceTemperature: 0.7,
    firstCarbonation: true,
  });

  assert.ok(estimate);
  assert.equal(estimate.setpointBasis, "first_cooling_kinetic");
  assert.ok(
    estimate.targetEquilibriumPressure >
      estimate.equilibriumPressureForCurrentCarb,
    "target carbonation must have a higher equilibrium-pressure anchor than current carbonation",
  );

  const expected =
    estimate.targetEquilibriumPressure +
    (2.4 - estimate.estimatedCurrentCarbonation) /
      estimate.setpointResponseVolPerBar;

  assert.ok(
    estimate.rawTargetPressure !== null &&
      Math.abs(estimate.rawTargetPressure - expected) <= 0.02,
    `expected kinetic target-equilibrium reserve near ${expected.toFixed(2)} bar, got ${estimate.rawTargetPressure}`,
  );

  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure >= 0.85 &&
      estimate.targetPressure <= 1.0,
    `expected a less aggressive first-cooling correction around 0.9 bar, got ${estimate.targetPressure}`,
  );
});


test("V5 uses elapsed time since the carbonation measurement", () => {
  const fresh = estimatePressureTargetV5({
    state: state(2.26, 1.44, 6.8, 0),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  const stale = estimatePressureTargetV5({
    state: state(2.26, 1.44, 6.8, 30),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(fresh);
  assert.ok(stale);
  assert.equal(fresh.hoursSinceCarbonationMeasurement, 0);
  assert.equal(stale.hoursSinceCarbonationMeasurement, 30);
  assert.ok(
    stale.estimatedCurrentCarbonation >
      fresh.estimatedCurrentCarbonation + 0.03,
    `expected 30h of stored pressure to advance carbonation: fresh=${fresh.estimatedCurrentCarbonation}, stale=${stale.estimatedCurrentCarbonation}`,
  );
  assert.notEqual(
    stale.targetPressure,
    fresh.targetPressure,
    "today vs yesterday must not produce the same target pressure",
  );
});

test("V5 applies the local equilibrium curve as a calibration offset", () => {
  const target = 2.45;
  const temp = 0.5;
  const standardTarget = equilibriumPressureBar(temp, target);
  if (standardTarget === null) throw new Error("invalid target equilibrium");

  const physicsOnly = estimatePressureTargetV5({
    state: state(2.26, 1.44, 6.8),
    targetCarbonation: target,
    coldReferenceTemperature: temp,
    firstCarbonation: true,
  });

  const locallyCalibrated = estimatePressureTargetV5({
    state: state(2.26, 1.44, 6.8),
    targetCarbonation: target,
    coldReferenceTemperature: temp,
    firstCarbonation: true,
    equilibriumPressureAtTemperature: () =>
      standardTarget + 0.15,
  });

  assert.ok(physicsOnly);
  assert.ok(locallyCalibrated);
  assert.ok(
    locallyCalibrated.equilibriumPressureForCurrentCarb >
      physicsOnly.equilibriumPressureForCurrentCarb + 0.1,
  );
  assert.ok(
    locallyCalibrated.targetPressure !== null &&
      physicsOnly.targetPressure !== null &&
      locallyCalibrated.targetPressure >
        physicsOnly.targetPressure,
  );
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

test("V5 recognizes when even zero pressure is not enough", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.85, 0.2, 1),
    targetCarbonation: 2.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.edgeCase, "venting_below_zero");
  assert.equal(estimate.targetPressure, null);
});


test("V5 subsequent stable check corrects from current pressure instead of restarting from equilibrium", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.45, 0.8, 1.7),
    targetCarbonation: 2.5,
    firstCarbonation: false,
  });

  assert.ok(estimate);
  assert.equal(estimate.mode, "stable");
  assert.equal(estimate.action, "raise");
  assert.equal(
    estimate.targetPressure,
    0.9,
    `2.45 -> 2.50 from 0.80 bar should produce one 0.10-bar operational increase, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.targetPressureRangeLow !== null &&
      estimate.targetPressureRangeHigh !== null &&
      estimate.targetPressureRangeLow >= 0.84 &&
      estimate.targetPressureRangeHigh <= 0.91,
    `unexpected stable correction range ${estimate.targetPressureRangeLow}-${estimate.targetPressureRangeHigh}`,
  );
});
