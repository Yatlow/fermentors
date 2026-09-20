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


test("V9 validation never starts a closed interval from a row whose yeast-drop note was appended after the morning pressure", () => {
  const batch = exactBatch("1700");

  batch.measurements = [
    {
      id: "2026-09-16_0800",
      carbonation: 2.20,
      pressure: 1.30,
      temp: 5.8,
    },
    {
      id: "2026-09-18_0800",
      carbonation: 2.27,
      pressure: 1.18,
      temp: 3.2,
      // Operational reality: 1.18 was measured in the morning. Later the same
      // day yeast was dropped and only the post-drop pressure was appended to
      // notes; the numeric pressure field stayed at 1.18.
      notes: "הורדת שמרים | לחץ אחרי 0.92 bar",
    },
    {
      id: "2026-09-20_0800",
      carbonation: 2.34,
      pressure: 0.86,
      temp: 1.5,
    },
  ];

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 123,
  });

  // The 16->18 interval may be used because the numeric endpoint is the morning
  // reading before the drop. The ambiguous 18->20 interval must never be used.
  assert.equal(result.caseCount, 1);
  assert.equal(
    result.cases[0]?.startMeasurementId,
    "2026-09-16_0800",
  );
  assert.equal(
    result.cases[0]?.endMeasurementId,
    "2026-09-18_0800",
  );
});


test("V9 validation rejects corrupt carbonation values instead of letting one typo dominate MAE", () => {
  const batch = exactBatch("1800");
  batch.measurements = [
    {
      id: "2026-09-16_0800",
      carbonation: 3.96,
      pressure: 1.1,
      temp: 2.0,
    },
    {
      id: "2026-09-17_0800",
      carbonation: 38,
      pressure: 1.0,
      temp: 1.8,
    },
  ];

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 1,
  });

  assert.equal(result.caseCount, 0);
});

test("V9 validation does not carry an older pressure or temperature into a later carbonation state", () => {
  const batch = exactBatch("1801");
  batch.measurements = [
    {
      id: "2026-09-16_0800",
      pressure: 1.2,
      temp: 4.0,
    },
    {
      id: "2026-09-17_0800",
      carbonation: 2.25,
    },
    {
      id: "2026-09-19_0800",
      carbonation: 2.35,
      pressure: 0.9,
      temp: 1.5,
    },
  ];

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 1,
  });

  assert.equal(result.caseCount, 0);
});


test("V9 validation recognizes common pressure-action wording variants", () => {
  const batch = exactBatch("1900");
  batch.measurements[0] = {
    ...batch.measurements[0],
    notes: "שחרור לחץ עד 1.15 באר",
  };

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 7,
  });

  assert.equal(result.caseCount, 1);
  assert.ok(result.carbonationMae !== null);
  assert.ok(result.carbonationMae! < 0.000001);
});

test("V9 validation excludes an intermediate pressure intervention even when the note is not in the canonical wording", () => {
  const batch = exactBatch("1901");
  batch.measurements.splice(1, 0, {
    id: "2026-09-19_0900",
    pressure: 1.05,
    temp: 3.2,
    notes: "פתח לחץ ושחרר עד 0.90 bar",
  });

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 7,
  });

  assert.equal(result.caseCount, 0);
});

test("V9 validation uses the observed temperature path instead of assuming linear cooling", () => {
  const temperaturePath = [
    { hour: 0, temperature: 6.4 },
    { hour: 24, temperature: 6.0 },
    { hour: 36, temperature: 3.0 },
    { hour: 48, temperature: 1.6 },
  ];
  const prediction = simulateV9ObservedClosedInterval({
    tankNumber: 16,
    beerVolumeLiters: 3000,
    startCarbonation: 2.27,
    startPressure: 1.15,
    startTemperature: 6.4,
    endTemperature: 1.6,
    durationHours: 48,
    kPerHour: 0.0025,
    temperaturePath,
  });
  assert.ok(prediction);

  const batch: PressureV9ValidationBatch = {
    batchId: "1902",
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
        notes: "הורדת לחץ ל 1.15 bar",
      },
      {
        id: "2026-09-19_0900",
        temp: 6.0,
      },
      {
        id: "2026-09-19_2100",
        temp: 3.0,
      },
      {
        id: "2026-09-20_0900",
        carbonation: prediction!.predictedCarbonation,
        pressure: prediction!.predictedPressure,
        temp: 1.6,
      },
    ],
  };

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 9,
  });

  assert.equal(result.caseCount, 1);
  assert.ok(result.carbonationMae !== null);
  assert.ok(result.carbonationMae! < 0.000001);
  assert.equal(result.cases[0]?.temperaturePathPointCount, 4);
});


test("V9 validation can recover a shorthand pressure target when the note only says a different bar value", () => {
  const batch = exactBatch("1903");
  batch.measurements[0] = {
    ...batch.measurements[0],
    pressure: 1.44,
    notes: "1.15 bar",
  };

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 11,
  });

  assert.equal(result.caseCount, 1);
  assert.ok(result.carbonationMae !== null);
  assert.ok(result.carbonationMae! < 0.000001);
});

test("V9 validation recognizes legacy three-digit measurement times when checking intervening pressure actions", () => {
  const batch = exactBatch("1904");
  batch.measurements.splice(1, 0, {
    id: "2026-09-19_930",
    pressure: 1.0,
    temp: 3.0,
    notes: "שחרור לחץ ל 0.85 bar",
  });

  const result = runPressureV9PhysicsValidation({
    batches: [batch],
    seed: 11,
  });

  assert.equal(result.caseCount, 0);
});
