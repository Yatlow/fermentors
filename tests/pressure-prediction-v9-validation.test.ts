import assert from "node:assert/strict";
import test from "node:test";
import {
  simulateV9ObservedClosedInterval,
} from "../src/SERVICES/cellering/pressurePredictionV9Physics";
import {
  runPressureV9PhysicsValidation,
  type PressureV9ValidationBatch,
} from "../src/SERVICES/cellering/pressurePredictionV9Validation";

function exactBatch(id: string): PressureV9ValidationBatch {
  const prediction = simulateV9ObservedClosedInterval({
    tankNumber: 16,
    beerVolumeLiters: 3000,
    startCarbonation: 2.27,
    startPressure: 1.15,
    startTemperature: 6.4,
    endTemperature: 1.6,
    durationHours: 48,
    kPerHour: 0.0025,
  });
  if (!prediction) throw new Error("prediction unavailable");

  return {
    batchId: id,
    style: "ipa",
    tankNumber: 16,
    beerVolumeLiters: 3000,
    kPerHour: 0.0025,
    measurements: [
      {
        id: "2026-09-18_0900",
        carbonation: 2.27,
        pressure: 1.44,
        temp: 6.4,
        notes: "הורדת לחץ ל1.15 bar",
      },
      {
        id: "2026-09-20_0900",
        carbonation: prediction.predictedCarbonation,
        pressure: prediction.predictedPressure,
        temp: 1.6,
      },
    ],
  };
}

test("V9 validation predicts a clean observed interval without comparing to a human decision", () => {
  const result = runPressureV9PhysicsValidation({
    batches: [exactBatch("1590")],
    seed: 12345,
  });

  assert.equal(result.caseCount, 1);
  assert.ok(result.carbonationMae !== null);
  assert.ok(result.carbonationMae! < 0.000001);
  assert.ok(result.pressureMae !== null);
  assert.ok(result.pressureMae! < 0.000001);
  assert.equal(result.byStyle[0]?.key, "ipa");
  assert.equal(result.byTankClass[0]?.key, "triple");
});

test("V9 validation excludes intervals contaminated by a later intervention", () => {
  const batch = exactBatch("1591");
  batch.measurements.splice(1, 0, {
    id: "2026-09-19_0900",
    pressure: 1.0,
    temp: 3.0,
    notes: "הורדת שמרים, לחץ אחרי 0.90 bar",
  });

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 1,
  });

  assert.equal(result.caseCount, 0);
});

test("V9 validation reports persistence baseline separately from physics error", () => {
  const result = runPressureV9PhysicsValidation({
    batches: [
      exactBatch("1600"),
      exactBatch("1601"),
      exactBatch("1602"),
    ],
    seed: 55,
  });

  assert.equal(result.caseCount, 3);
  assert.ok(result.persistenceMae !== null);
  assert.ok(result.persistenceMae! > 0);
  assert.ok(result.improvementVsPersistence !== null);
  assert.ok(result.improvementVsPersistence! > 0.99);
});
