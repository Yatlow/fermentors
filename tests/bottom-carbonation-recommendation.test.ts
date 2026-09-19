import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateBottomCarbonation,
  type BottomCarbonationSample,
} from "../src/SERVICES/cellering/bottomCarbonationEstimator";

function bottomSample(
  overrides: Partial<BottomCarbonationSample> = {},
): BottomCarbonationSample {
  return {
    carbonationBefore: 2.05,
    pressureBefore: 0.8,
    startPressure: 0.2,
    closePressure: 0.75,
    durationMinutes: 45,
    carbonationAfter: 2.28,
    carbonationDelta: 0.23,
    elapsedDays: 1,
    brewDay: 20,
    temp: 1.5,
    success: true,
    ...overrides,
  };
}

test("bottom carbonation recommends learned pressures and duration below threshold", () => {
  const samples = Array.from({ length: 12 }, (_, index) =>
    bottomSample({
      carbonationBefore: 2.02 + (index % 3) * 0.02,
      durationMinutes: 40 + (index % 3) * 5,
      carbonationDelta: 0.20 + (index % 2) * 0.02,
    })
  );

  const estimate = estimateBottomCarbonation({
    samples,
    currentCarbonation: 2.04,
    targetCarbonation: 2.45,
    currentPressure: 0.9,
    brewDay: 20,
    temp: 1.5,
  });

  assert.ok(estimate);
  assert.equal(estimate.startPressure, 0.2);
  assert.equal(estimate.closePressure, 0.75);
  assert.ok(estimate.durationMinutes >= 40);
  assert.ok(estimate.durationMinutes <= 50);
  assert.equal(estimate.sampleCount, 12);
  assert.equal(estimate.confidence, "high");
});

test("bottom carbonation does not trigger above learned/capped threshold", () => {
  const samples = Array.from({ length: 12 }, () => bottomSample());

  const estimate = estimateBottomCarbonation({
    samples,
    currentCarbonation: 2.25,
    targetCarbonation: 2.45,
    currentPressure: 0.9,
  });

  assert.equal(estimate, null);
});

test("bottom carbonation requires at least five useful historical sessions", () => {
  const samples = Array.from({ length: 4 }, () => bottomSample());

  const estimate = estimateBottomCarbonation({
    samples,
    currentCarbonation: 2.05,
    targetCarbonation: 2.45,
  });

  assert.equal(estimate, null);
});


test("bottom carbonation learns a stricter trigger than the 2.20 fallback", () => {
  const samples = Array.from({ length: 12 }, (_, index) =>
    bottomSample({
      carbonationBefore: 1.98 + (index % 3) * 0.02,
    })
  );

  const estimate = estimateBottomCarbonation({
    samples,
    currentCarbonation: 2.12,
    targetCarbonation: 2.45,
    currentPressure: 0.9,
  });

  assert.equal(
    estimate,
    null,
    "once history is sufficient, a style-specific threshold should replace the broad 2.20 fallback",
  );
});


function v4State(
  pressureMean24h: number,
  equilibriumDeltaBarHours: number,
) {
  return {
    carbonation: 2.05,
    hoursSinceT0: 96,
    currentPressure: pressureMean24h,
    currentTemp: 2,
    exposure: {
      hoursSinceT0: 96,
      pressureHours: pressureMean24h * 96,
      temperatureHours: 2 * 96,
      equilibriumDeltaBarHours,
      pressureMean: pressureMean24h,
      pressureMean24h,
      pressureMean48h: pressureMean24h,
      temperatureMean: 2,
      pressurePoints: 6,
      temperaturePoints: 6,
      coveredHours: 96,
      coverageRatio: 1,
    },
  };
}

test("bottom carbonation uses the same V4 tank state to choose historical response", () => {
  const highExposure = Array.from({ length: 20 }, (_, index) =>
    bottomSample({
      batchId: `high-${index}`,
      durationMinutes: 30,
      carbonationDelta: 0.18,
      state: {
        ...v4State(1.35, 55),
        quality: "high",
      },
    })
  );
  const lowExposure = Array.from({ length: 20 }, (_, index) =>
    bottomSample({
      batchId: `low-${index}`,
      durationMinutes: 90,
      carbonationDelta: 0.18,
      state: {
        ...v4State(0.75, -5),
        quality: "high",
      },
    })
  );

  const high = estimateBottomCarbonation({
    samples: [...highExposure, ...lowExposure],
    currentCarbonation: 2.05,
    targetCarbonation: 2.25,
    currentPressure: 1.35,
    temp: 2,
    state: v4State(1.35, 55),
  });
  const low = estimateBottomCarbonation({
    samples: [...highExposure, ...lowExposure],
    currentCarbonation: 2.05,
    targetCarbonation: 2.25,
    currentPressure: 0.75,
    temp: 2,
    state: v4State(0.75, -5),
  });

  assert.ok(high);
  assert.ok(low);
  assert.ok(
    high.durationMinutes < low.durationMinutes,
    "the same carbonation deficit should use different bottom-carbonation duration when V4 exposure differs",
  );
});
