import assert from "node:assert/strict";
import test from "node:test";
import type {
  PressureV4DecisionState,
  PressureV4Exposure,
} from "../src/SERVICES/cellering/pressurePredictionV4";
import {
  estimatePressureTargetV8,
} from "../src/SERVICES/cellering/pressurePredictionV8";

function exposure(
  pressure: number,
  hours: number,
  temp: number,
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
    pressurePoints: 6,
    temperaturePoints: 6,
    coveredHours: hours,
    coverageRatio: 1,
  };
}

function state(): PressureV4DecisionState {
  return {
    carbonation: 2.26,
    currentPressure: 1.44,
    currentTemp: 6.5,
    hoursSinceT0: 220,
    exposure: exposure(1.44, 220, 6.5),
    cooling: {
      startDateTimeMs: Date.now() - 48 * 3600000,
      hoursSinceCooling: 48,
      startTemp: 20,
      currentTemp: 6.5,
      tempDropSinceCooling: 13.5,
      tempChange24h: -5,
      pressureMeanSinceCooling: 1.44,
      pressureMean24h: 1.44,
      pressureHoursSinceCooling: 1.44 * 48,
      equilibriumDeltaBarHoursSinceCooling: null,
      coverageRatio: 1,
      stillCooling: true,
    },
    carbonationTrend: null,
    currentCarbonationDateTimeMs: Date.now(),
    hoursSinceCurrentCarbonation: 0,
    postCarbonationExposure: null,
  };
}

function batch(
  id: string,
  treatmentDelta: number,
  success: boolean,
) {
  const actionPressure = 1.44 + treatmentDelta;
  const decisionNote =
    Math.abs(treatmentDelta) < 0.05
      ? ""
      : `הורדת לחץ ל${actionPressure.toFixed(2)} bar`;

  return {
    batchId: id,
    measurements: [
      {
        id: "2026-06-01_0800",
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-06-02_0900",
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: decisionNote,
      },
      success
        ? {
            id: "2026-06-05_0900",
            carbonation: 2.45,
            temp: 0.7,
            pressure: 0.65,
            notes: "",
          }
        : {
            id: "2026-06-03_0900",
            temp: 2.0,
            pressure: 1.20,
            notes: "גיזוז מלמטה",
          },
    ],
  };
}

test("V8 recommends a treatment only when matched states show a causal lift versus HOLD", () => {
  const histories = [
    ...Array.from({ length: 10 }, (_, index) =>
      batch(
        `hold-${index}`,
        0,
        index < 5,
      )
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      batch(
        `treat-${index}`,
        -0.20,
        index < 9,
      )
    ),
  ];

  const estimate = estimatePressureTargetV8({
    state: state(),
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    currentBatchId: "current",
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure !== null &&
      Math.abs(estimate.targetPressure - 1.24) <= 0.01,
    `expected causal -0.20 bar treatment, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.causalEffectVsHold !== null &&
      estimate.causalEffectVsHold >= 0.25,
  );
  assert.ok(
    estimate.effectLower80 !== null &&
      estimate.effectLower80 > 0,
  );
  assert.ok(estimate.matchedPairs >= 4);
});

test("V8 abstains when there is no comparable HOLD control group", () => {
  const histories = Array.from({ length: 10 }, (_, index) =>
    batch(
      `only-treatment-${index}`,
      -0.20,
      true,
    )
  );

  const estimate = estimatePressureTargetV8({
    state: state(),
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "insufficient_data");
  assert.equal(estimate.targetPressure, null);
  assert.equal(estimate.abstentionReason, "no_hold_overlap");
});
