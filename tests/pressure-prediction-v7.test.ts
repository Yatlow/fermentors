import assert from "node:assert/strict";
import test from "node:test";
import type {
  PressureV4DecisionState,
  PressureV4Exposure,
} from "../src/SERVICES/cellering/pressurePredictionV4";
import {
  estimatePressureTargetV7,
} from "../src/SERVICES/cellering/pressurePredictionV7";

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

function state(
  carbonation = 2.26,
  pressure = 1.44,
  temp = 6.5,
): PressureV4DecisionState {
  return {
    carbonation,
    currentPressure: pressure,
    currentTemp: temp,
    hoursSinceT0: 220,
    exposure: exposure(pressure, 220, temp),
    cooling: {
      startDateTimeMs: Date.now() - 48 * 3600000,
      hoursSinceCooling: 48,
      startTemp: 20,
      currentTemp: temp,
      tempDropSinceCooling: 20 - temp,
      tempChange24h: -5,
      pressureMeanSinceCooling: pressure,
      pressureMean24h: pressure,
      pressureHoursSinceCooling: pressure * 48,
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

function successBatch(
  id: string,
  actionPressure: number,
) {
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
        notes: `הורדת לחץ ל${actionPressure.toFixed(2)} bar`,
      },
      {
        id: "2026-06-05_0900",
        carbonation: 2.45,
        temp: 0.7,
        pressure: 0.65,
      },
    ],
  };
}

function failedHighPressureBatch(
  id: string,
  actionPressure: number,
) {
  return {
    batchId: id,
    measurements: [
      {
        id: "2026-05-01_0800",
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-05-02_0900",
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: `הורדת לחץ ל${actionPressure.toFixed(2)} bar`,
      },
      {
        id: "2026-05-03_0900",
        carbonation: 2.33,
        temp: 2.0,
        pressure: 1.30,
        notes: "הורדת לחץ ל1.15 bar",
      },
      {
        id: "2026-05-05_0900",
        carbonation: 2.45,
        temp: 0.7,
        pressure: 0.65,
      },
    ],
  };
}

test("V7 chooses the pressure region with the strongest historical outcome", () => {
  const histories = [
    ...Array.from({ length: 10 }, (_, index) =>
      successBatch(
        `success-${index}`,
        1.13 + (index % 3) * 0.02,
      )
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      failedHighPressureBatch(
        `fail-${index}`,
        1.36 + (index % 3) * 0.02,
      )
    ),
  ];

  const estimate = estimatePressureTargetV7({
    state: state(),
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    currentBatchId: "current",
  });

  assert.ok(estimate);
  assert.notEqual(estimate.action, "insufficient_data");
  assert.ok(estimate.targetPressure !== null);
  assert.ok(
    estimate.targetPressure! >= 1.05 &&
      estimate.targetPressure! <= 1.25,
    `expected V7 near successful 1.15 bar region, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.estimatedSuccessProbability !== null &&
      estimate.estimatedSuccessProbability >= 0.7,
  );
});

test("V7 abstains when there are not enough comparable batches", () => {
  const histories = Array.from({ length: 3 }, (_, index) =>
    successBatch(`thin-${index}`, 1.15)
  );

  const estimate = estimatePressureTargetV7({
    state: state(),
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "insufficient_data");
  assert.equal(estimate.targetPressure, null);
});
