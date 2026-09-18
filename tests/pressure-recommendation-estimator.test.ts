import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTarget,
  type PressureResponseSample,
} from "../src/SERVICES/cellering/pressureRecommendationEstimator";

function sample(
  pressureDelta: number,
  carbonationDelta: number,
  overrides: Partial<PressureResponseSample> = {},
): PressureResponseSample {
  return {
    carbonationBefore: 2.3,
    pressureBefore: 1.2,
    targetPressure: 1.2 + pressureDelta,
    pressureDelta,
    carbonationAfter: 2.3 + carbonationDelta,
    carbonationDelta,
    elapsedDays: 2,
    brewDay: 18,
    temp: 1.5,
    success: true,
    ...overrides,
  };
}

test("pressure recommendation raises pressure when carbonation is low", () => {
  const samples = Array.from({ length: 8 }, (_, index) =>
    sample(0.2, 0.1 + (index % 2) * 0.01)
  );

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.45,
    currentPressure: 1.2,
    brewDay: 18,
    temp: 1.5,
  });

  assert.ok(estimate);
  assert.ok(estimate.pressureDelta > 0);
  assert.ok(estimate.targetPressure > 1.2);
  assert.equal(estimate.sampleCount, 8);
  assert.equal(estimate.confidence, "medium");
});

test("pressure recommendation lowers pressure when carbonation is high", () => {
  const samples = Array.from({ length: 14 }, (_, index) =>
    sample(-0.2, -0.11 - (index % 2) * 0.01)
  );

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.65,
    targetCarbonation: 2.45,
    currentPressure: 1.6,
    brewDay: 20,
    temp: 1.2,
  });

  assert.ok(estimate);
  assert.ok(estimate.pressureDelta < 0);
  assert.ok(estimate.targetPressure < 1.6);
  assert.equal(estimate.confidence, "high");
});

test("pressure recommendation refuses to learn from too few outcomes", () => {
  const samples = Array.from({ length: 4 }, () => sample(0.2, 0.1));

  const estimate = estimatePressureTarget({
    samples,
    currentCarbonation: 2.3,
    targetCarbonation: 2.45,
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
    targetCarbonation: 2.45,
    currentPressure: 1.2,
  });

  assert.equal(estimate, null);
});
