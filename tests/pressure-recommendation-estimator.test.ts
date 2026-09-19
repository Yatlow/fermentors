import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTarget,
  type PressureResponseSample,
} from "../src/SERVICES/cellering/pressureRecommendationEstimator";

function sample(
  pressureOffset: number,
  carbonationDelta: number,
  overrides: Partial<PressureResponseSample> = {},
): PressureResponseSample {
  const equilibrium = 0.8;
  return {
    carbonationBefore: 2.3,
    pressureBefore: 1.2,
    targetPressure: equilibrium + pressureOffset,
    pressureDelta: pressureOffset,
    pressureAfter: equilibrium,
    carbonationAfter: 2.3 + carbonationDelta,
    carbonationDelta,
    elapsedDays: 2,
    brewDay: 18,
    temp: 1.5,
    success: true,
    ...overrides,
  };
}

test("pressure recommendation anchors low carbonation correction to equilibrium", () => {
  const samples = Array.from({ length: 8 }, (_, index) =>
    sample(0.2, 0.1 + (index % 2) * 0.01)
  );

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.4,
    currentPressure: 1.44,
    brewDay: 18,
    temp: 1.5,
  });

  assert.ok(estimate);
  assert.equal(estimate.equilibriumPressure, 0.8);
  assert.ok(estimate.pressureDelta > 0);
  assert.ok(estimate.targetPressure > estimate.equilibriumPressure);
  assert.ok(
    estimate.targetPressure < 1.44,
    "a positive carbonation correction can still require lowering transient current pressure",
  );
  assert.ok(estimate.currentPressureChange < 0);
  assert.equal(estimate.sampleCount, 8);
  assert.equal(estimate.confidence, "medium");
});

test("pressure recommendation can target below equilibrium for high carbonation", () => {
  const samples = Array.from({ length: 14 }, (_, index) =>
    sample(-0.2, -0.11 - (index % 2) * 0.01, {
      carbonationBefore: 2.65,
      carbonationAfter: 2.54 - (index % 2) * 0.01,
    })
  );

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.65,
    targetCarbonation: 2.55,
    currentPressure: 1.1,
    brewDay: 20,
    temp: 1.2,
  });

  assert.ok(estimate);
  assert.ok(estimate.pressureDelta < 0);
  assert.ok(estimate.targetPressure < estimate.equilibriumPressure);
  assert.equal(estimate.confidence, "high");
});

test("pressure recommendation refuses to learn from too few outcomes", () => {
  const samples = Array.from({ length: 4 }, () => sample(0.2, 0.1));

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.4,
    currentPressure: 1.2,
  });

  assert.equal(estimate, null);
});

test("pressure recommendation ignores outcomes in the wrong direction", () => {
  const samples = [
    ...Array.from({ length: 4 }, () => sample(0.2, 0.1)),
    ...Array.from({ length: 8 }, () => sample(-0.2, -0.1)),
  ];

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.4,
    currentPressure: 1.2,
  });

  assert.equal(estimate, null);
});

test("pressure recommendation applies learned response calibration", () => {
  const samples = Array.from({ length: 12 }, () => sample(0.2, 0.1));

  const uncalibrated = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.4,
    currentPressure: 1.2,
  });
  const calibrated = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.4,
    currentPressure: 1.2,
    calibration: {
      responseMultiplier: 1.2,
      evaluatedSamples: 20,
      within005Rate: 0.8,
      equilibriumPressure: 0.8,
      equilibriumSampleCount: 20,
    },
  });

  assert.ok(uncalibrated);
  assert.ok(calibrated);
  assert.equal(calibrated.calibrationMultiplier, 1.2);
  assert.equal(calibrated.calibrationEvaluatedSamples, 20);
  assert.equal(calibrated.calibrationWithin005Rate, 0.8);
  assert.ok(
    calibrated.targetPressure <= uncalibrated.targetPressure,
    "stronger learned response should not require a larger pressure target above equilibrium",
  );
});

test("low calibration accuracy prevents high confidence", () => {
  const samples = Array.from({ length: 14 }, () => sample(0.2, 0.1));

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.4,
    currentPressure: 1.2,
    calibration: {
      responseMultiplier: 1,
      evaluatedSamples: 30,
      within005Rate: 0.4,
      equilibriumPressure: 0.8,
      equilibriumSampleCount: 30,
    },
  });

  assert.ok(estimate);
  assert.equal(estimate.confidence, "medium");
});
