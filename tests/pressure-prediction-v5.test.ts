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

test("V5 first-cooling setpoint keeps the cooling anchor but strengthens a large miss", () => {
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
  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure >= 0.95 &&
      estimate.targetPressure <= 1.15,
    `expected first-cooling correction around 1.0 bar, got ${estimate.targetPressure}`,
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


test("V5 stable correction becomes progressively stronger away from target", () => {
  const pressure = 0.77;
  const target = 2.45;

  const near = estimatePressureTargetV5({
    state: state(2.52, pressure, 0.3),
    targetCarbonation: target,
    firstCarbonation: false,
  });
  const high = estimatePressureTargetV5({
    state: state(2.58, pressure, 0.3),
    targetCarbonation: target,
    firstCarbonation: false,
  });
  const veryHigh = estimatePressureTargetV5({
    state: state(2.66, pressure, 0.3),
    targetCarbonation: target,
    firstCarbonation: false,
  });
  const low = estimatePressureTargetV5({
    state: state(2.32, pressure, 0.3),
    targetCarbonation: target,
    firstCarbonation: false,
  });
  const veryLow = estimatePressureTargetV5({
    state: state(2.25, pressure, 0.3),
    targetCarbonation: target,
    firstCarbonation: false,
  });

  assert.ok(near && high && veryHigh && low && veryLow);
  assert.ok(near.targetPressure !== null && near.targetPressure >= 0.6);
  assert.ok(high.targetPressure !== null && high.targetPressure <= 0.5);
  assert.ok(
    veryHigh.targetPressure === null ||
      (veryHigh.targetPressure !== null && veryHigh.targetPressure <= 0.15),
    `large over-carbonation should drive pressure to atmospheric/venting territory, got ${veryHigh.targetPressure}`,
  );
  assert.ok(low.targetPressure !== null && low.targetPressure >= 1.05);
  assert.ok(veryLow.targetPressure !== null && veryLow.targetPressure >= 1.35);
});

test("V5 first-cooling miss gets nonlinear correction without losing cooling anchor", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.00097),
  );

  const estimate = estimatePressureTargetV5({
    transitions,
    state: state(2.26, 1.37, 4.5),
    targetCarbonation: 2.4,
    coldReferenceTemperature: 0.7,
    firstCarbonation: true,
  });

  assert.ok(estimate);
  assert.equal(estimate.mode, "first_cooling");
  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure >= 0.9 &&
      estimate.targetPressure <= 1.1,
    `expected first-cooling correction near 1.0 bar, got ${estimate.targetPressure}`,
  );
});


test("V5 learned response does not change when only hypothetical carbonation changes", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.0027 + (index % 3) * 0.0002),
  );
  const values = [2.52, 2.58, 2.66].map((carbonation) =>
    estimatePressureTargetV5({
      transitions,
      state: state(carbonation, 0.77, 0.3),
      targetCarbonation: 2.45,
      firstCarbonation: false,
    })
  );

  values.forEach((estimate) => assert.ok(estimate));
  const responses = values.map((estimate) => estimate!.setpointResponseVolPerBar);
  assert.ok(
    Math.max(...responses) - Math.min(...responses) < 0.001,
    `changing only carbonation must not re-learn a different response: ${responses.join(", ")}`,
  );
});

test("V5 stable setpoints are monotonic as carbonation moves away from target", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.0027 + (index % 3) * 0.0002),
  );
  const estimate = (carbonation: number) =>
    estimatePressureTargetV5({
      transitions,
      state: state(carbonation, 0.77, 0.3),
      targetCarbonation: 2.45,
      firstCarbonation: false,
    });

  const c252 = estimate(2.52);
  const c258 = estimate(2.58);
  const c266 = estimate(2.66);
  const c240 = estimate(2.40);
  const c232 = estimate(2.32);
  const c225 = estimate(2.25);

  [c252, c258, c266, c240, c232, c225].forEach((row) => assert.ok(row));

  const pressureOrBelowZero = (row: NonNullable<typeof c252>) =>
    row.targetPressure ?? (row.edgeCase === "venting_below_zero" ? -0.01 : 99);

  assert.ok(
    pressureOrBelowZero(c252!) > pressureOrBelowZero(c258!) &&
      pressureOrBelowZero(c258!) > pressureOrBelowZero(c266!),
    `over-carbonation targets must fall monotonically: ${pressureOrBelowZero(c252!)}, ${pressureOrBelowZero(c258!)}, ${pressureOrBelowZero(c266!)}`,
  );
  assert.ok(
    c240!.targetPressure !== null &&
      c232!.targetPressure !== null &&
      c225!.targetPressure !== null &&
      c240!.targetPressure < c232!.targetPressure &&
      c232!.targetPressure < c225!.targetPressure,
    `under-carbonation targets must rise monotonically: ${c240!.targetPressure}, ${c232!.targetPressure}, ${c225!.targetPressure}`,
  );

  assert.ok(c252!.targetPressure !== null && c252!.targetPressure >= 0.6);
  assert.ok(c258!.targetPressure !== null && c258!.targetPressure <= 0.5);
  assert.ok(
    c266!.edgeCase === "venting_below_zero" ||
      (c266!.targetPressure !== null && c266!.targetPressure <= 0.1),
  );
  assert.ok(c232!.targetPressure !== null && c232!.targetPressure >= 1.05);
  assert.ok(c225!.targetPressure !== null && c225!.targetPressure >= 1.35);
});



test("V5 keeps an exact 0.02 vol miss inside the quiet band", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.52, 0.61, 0.4),
    targetCarbonation: 2.50,
    firstCarbonation: false,
  });

  assert.ok(estimate);
  assert.ok(
    estimate.targetPressure !== null &&
      Math.abs(estimate.targetPressure - 0.61) < 0.05,
    `2.52 vs 2.50 should stay effectively HOLD, got ${estimate.targetPressure}`,
  );
  assert.equal(estimate.action, "hold");
});

test("V5 first correction step just outside the quiet band is 0.05 bar", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.55, 0.80, 0.5),
    targetCarbonation: 2.50,
    firstCarbonation: false,
  });

  assert.ok(estimate);
  assert.ok(
    estimate.targetPressure !== null &&
      estimate.targetPressure <= 0.75 &&
      estimate.targetPressure >= 0.70,
    `expected first operational drop around 0.05 bar, got ${estimate.targetPressure}`,
  );
});

test("V5 first-carbonation checks on tanks 18 and 16 stay near 1.1 bar without nonlinear gain", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.00097),
  );

  const tank18 = estimatePressureTargetV5({
    transitions,
    state: state(2.26, 1.37, 4.5),
    targetCarbonation: 2.40,
    coldReferenceTemperature: 0.7,
    firstCarbonation: true,
  });

  const tank16 = estimatePressureTargetV5({
    transitions,
    state: state(2.26, 1.44, 6.8),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(tank18);
  assert.ok(tank16);
  for (const [name, estimate] of [["tank18", tank18], ["tank16", tank16]] as const) {
    assert.equal(estimate.mode, "first_cooling");
    assert.ok(
      estimate.targetPressure !== null &&
        estimate.targetPressure >= 0.95 &&
        estimate.targetPressure <= 1.20,
      `${name} should land around 1.1 bar, got ${estimate.targetPressure}`,
    );
  }
});


test("V5 stable recommendations use fine-grained setpoints between 0.05-bar action steps", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.0027 + (index % 3) * 0.0002),
  );

  const pressures = [2.25, 2.26, 2.27, 2.28, 2.29, 2.30]
    .map((carbonation) =>
      estimatePressureTargetV5({
        transitions,
        state: state(carbonation, 0.80, 0.5),
        targetCarbonation: 2.50,
        firstCarbonation: false,
      })
    )
    .map((estimate) => {
      assert.ok(estimate);
      assert.ok(estimate.targetPressure !== null);
      return estimate.targetPressure!;
    });

  const distinct = new Set(pressures.map((value) => value.toFixed(2)));
  assert.ok(
    distinct.size >= 4,
    `nearby carbonation values should grade pressure smoothly, got ${pressures.join(", ")}`,
  );

  assert.ok(
    pressures.some((value) => Math.round(value * 100) % 5 !== 0),
    `setpoints should not all be locked to 0.05-bar buckets: ${pressures.join(", ")}`,
  );
});

test("V5 first cooling retains stored head pressure as cooling progresses", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.00097),
  );

  const tank18 = estimatePressureTargetV5({
    transitions,
    state: state(2.32, 1.37, 4.5),
    targetCarbonation: 2.40,
    coldReferenceTemperature: 0.7,
    firstCarbonation: true,
  });

  const tank16 = estimatePressureTargetV5({
    transitions,
    state: state(2.32, 1.44, 6.8),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(tank18);
  assert.ok(tank16);
  assert.equal(tank18.mode, "first_cooling");
  assert.equal(tank16.mode, "first_cooling");

  assert.ok(
    tank18.targetPressure !== null &&
      tank18.targetPressure >= 1.00 &&
      tank18.targetPressure <= 1.20,
    `tank18 2.32 first check should stay around 1.1 bar, got ${tank18.targetPressure}`,
  );
  assert.ok(
    tank16.targetPressure !== null &&
      tank16.targetPressure >= 1.00 &&
      tank16.targetPressure <= 1.20,
    `tank16 2.32 first check should stay around 1.1 bar, got ${tank16.targetPressure}`,
  );
});


test("V5 first cooling at target converges to cold equilibrium plus small safety margin", () => {
  const transitions = Array.from(
    { length: 24 },
    (_, index) => transition(index, 0.00097),
  );

  const tank18 = estimatePressureTargetV5({
    transitions,
    state: state(2.40, 1.37, 4.5),
    targetCarbonation: 2.40,
    coldReferenceTemperature: 0.7,
    firstCarbonation: true,
  });

  const tank16 = estimatePressureTargetV5({
    transitions,
    state: state(2.45, 1.44, 6.8),
    targetCarbonation: 2.45,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(tank18);
  assert.ok(tank16);

  assert.ok(
    tank18.targetPressure !== null &&
      tank18.targetPressure >= 0.50 &&
      tank18.targetPressure <= 0.65,
    `tank18 at target should settle near equilibrium + safety, got ${tank18.targetPressure}`,
  );

  assert.ok(
    tank16.targetPressure !== null &&
      tank16.targetPressure >= 0.68 &&
      tank16.targetPressure <= 0.78,
    `tank16 at target should settle near equilibrium + safety, got ${tank16.targetPressure}`,
  );
});


test("V5 uses carbonation tolerance supplied by specs", () => {
  const loose = estimatePressureTargetV5({
    state: state(2.42, 0.80, 0.5),
    targetCarbonation: 2.45,
    targetToleranceVol: 0.04,
    firstCarbonation: false,
  });

  const tight = estimatePressureTargetV5({
    state: state(2.42, 0.80, 0.5),
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    firstCarbonation: false,
  });

  assert.ok(loose);
  assert.ok(tight);
  assert.equal(loose.action, "hold");
  assert.notEqual(
    tight.action,
    "hold",
    `0.03 tolerance should make an exact 0.03 miss actionable, got ${tight.targetPressure}`,
  );
  assert.equal(loose.targetToleranceVol, 0.04);
  assert.equal(tight.targetToleranceVol, 0.03);
});

test("V5 first cooling can raise head pressure below the stable bottom-carbonation cutoff", () => {
  const firstLow = estimatePressureTargetV5({
    state: state(2.05, 0.60, 6.8),
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  const stable214 = estimatePressureTargetV5({
    state: state(2.14, 0.80, 0.5),
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    firstCarbonation: false,
  });

  assert.ok(firstLow);
  assert.ok(stable214);
  assert.equal(firstLow.edgeCase, null);
  assert.equal(firstLow.action, "raise");
  assert.ok(
    firstLow.targetPressure !== null &&
      firstLow.targetPressure > firstLow.currentPressure &&
      firstLow.targetPressure <= 1.9,
    `first check should use an ordinary pressure raise when feasible, got ${firstLow.targetPressure}`,
  );
  assert.equal(stable214.edgeCase, "bottom_carbonation");
});


test("V5 stable hold is tank-only context, not a global recommendation", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.43, 0.86, 0.5),
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    firstCarbonation: false,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "hold");
  assert.equal(estimate.holdReason, "stable_in_tolerance");
  assert.equal(estimate.recommendationVisibility, "tank_only");
});

test("V5 first-cooling HOLD requires the no-change forecast itself to land in spec", () => {
  const estimate = estimatePressureTargetV5({
    state: state(2.13, 1.44, 6.8),
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    coldReferenceTemperature: 0.5,
    firstCarbonation: true,
  });

  assert.ok(estimate);
  assert.equal(estimate.mode, "first_cooling");
  assert.equal(estimate.action, "hold");
  assert.equal(estimate.holdReason, "first_cooling_forecast_on_target");
  assert.equal(estimate.recommendationVisibility, "global");
  assert.equal(estimate.targetPressure, 1.44);
  assert.ok(
    estimate.predictedWithoutChange >=
      estimate.targetCarbonation - estimate.targetToleranceVol &&
    estimate.predictedWithoutChange <=
      estimate.targetCarbonation + estimate.targetToleranceVol,
    `HOLD must mean no-change forecast is in spec, got ${estimate.predictedWithoutChange}`,
  );
});
