import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTarget,
  type PressureEquilibriumObservation,
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


test("same style target uses the same stable equilibrium across current tank contexts", () => {
  const samples = Array.from({ length: 14 }, (_, index) =>
    sample(-0.2, -0.1 - (index % 2) * 0.01, {
      carbonationBefore: 2.55,
      carbonationAfter: 2.45 - (index % 2) * 0.01,
    })
  );

  const equilibriumObservations: PressureEquilibriumObservation[] = [];
  for (let batch = 0; batch < 5; batch += 1) {
    const base = 0.78 + batch * 0.01;
    for (let day = 0; day < 3; day += 1) {
      equilibriumObservations.push({
        batchId: `stable-${batch}`,
        date: `2026-09-${String(10 + day).padStart(2, "0")}`,
        brewDay: 18 + batch,
        temp: 1 + batch * 0.2,
        carbonation: 2.45 + (day - 1) * 0.01,
        pressure: base + (day - 1) * 0.01,
      });
    }
  }

  const first = estimatePressureTarget({
    samples,
    equilibriumObservations,
    currentCarbonation: 2.55,
    targetCarbonation: 2.45,
    currentPressure: 0.83,
    brewDay: 17,
    temp: 0.6,
  });
  const second = estimatePressureTarget({
    samples,
    equilibriumObservations,
    currentCarbonation: 2.55,
    targetCarbonation: 2.45,
    currentPressure: 1.44,
    brewDay: 30,
    temp: 6.8,
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.equilibriumPressure, 0.8);
  assert.equal(second.equilibriumPressure, 0.8);
  assert.equal(first.equilibriumSampleCount, 5);
  assert.equal(second.equilibriumSampleCount, 5);
});

test("same-day repeated readings do not count as a stable equilibrium period", () => {
  const samples = Array.from({ length: 14 }, () =>
    sample(-0.2, -0.1, {
      carbonationBefore: 2.55,
      carbonationAfter: 2.45,
    })
  );

  const equilibriumObservations: PressureEquilibriumObservation[] =
    Array.from({ length: 15 }, (_, index) => ({
      batchId: `batch-${Math.floor(index / 3)}`,
      date: "2026-09-12",
      temp: 1.5,
      carbonation: 2.45,
      pressure: 1.2 + (index % 3) * 0.01,
    }));

  const estimate = estimatePressureTarget({
    samples,
    equilibriumObservations,
    currentCarbonation: 2.55,
    targetCarbonation: 2.45,
    currentPressure: 1.2,
    calibration: {
      equilibriumPressure: 0.8,
      equilibriumSampleCount: 20,
    },
  });

  assert.ok(estimate);
  assert.equal(estimate.equilibriumPressure, 0.8);
  assert.notEqual(estimate.equilibriumPressure, 1.21);
});


test("larger carbonation deficits do not collapse to the same pressure target", () => {
  const samples = Array.from({ length: 20 }, (_, index) =>
    sample(0.4, 0.08 + (index % 2) * 0.01, {
      carbonationBefore: 2.2 + (index % 3) * 0.03,
      carbonationAfter: 2.28 + (index % 3) * 0.03,
      pressureBefore: 1.4,
      targetPressure: 1.05,
      pressureAfter: 0.65,
    })
  );

  const common = {
    samples,
    targetCarbonation: 2.45,
    currentPressure: 1.44,
    calibration: {
      equilibriumPressure: 0.65,
      equilibriumSampleCount: 20,
      responseMultiplier: 1,
      evaluatedSamples: 20,
      within005Rate: 0.8,
    },
  };

  const mild = estimatePressureTarget({
    ...common,
    currentCarbonation: 2.4,
  });
  const medium = estimatePressureTarget({
    ...common,
    currentCarbonation: 2.3,
  });
  const large = estimatePressureTarget({
    ...common,
    currentCarbonation: 2.26,
  });

  assert.ok(mild);
  assert.ok(medium);
  assert.ok(large);
  assert.ok(mild.targetPressure < medium.targetPressure);
  assert.ok(medium.targetPressure <= large.targetPressure);
});
