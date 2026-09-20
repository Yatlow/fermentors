import assert from "node:assert/strict";
import test from "node:test";
import {
  simulateV9ObservedClosedInterval,
} from "../src/SERVICES/cellering/pressurePredictionV9Physics";
import {
  calibratePressureV9,
} from "../src/SERVICES/cellering/pressurePredictionV9Calibration";
import type {
  PressureV9ValidationBatch,
} from "../src/SERVICES/cellering/pressurePredictionV9Validation";

function syntheticDoubleBatch(
  index: number,
): PressureV9ValidationBatch {
  const trueVesselVolume = 2800;
  const trueK = 0.0032;
  const beerVolume = 2180 + (index % 5) * 15;
  const startCarbonation =
    2.18 + (index % 7) * 0.015;
  const startPressure =
    1.05 + (index % 6) * 0.07;
  const startTemperature =
    5.4 + (index % 5) * 0.35;
  const endTemperature =
    0.9 + (index % 4) * 0.25;
  const durationHours =
    index % 3 === 0 ? 72 : 48;

  const prediction =
    simulateV9ObservedClosedInterval({
      tankNumber: 6,
      beerVolumeLiters: beerVolume,
      vesselVolumeLiters: trueVesselVolume,
      startCarbonation,
      startPressure,
      startTemperature,
      endTemperature,
      durationHours,
      kPerHour: trueK,
    });
  if (!prediction) {
    throw new Error("synthetic prediction unavailable");
  }

  const day =
    String((index % 20) + 1).padStart(2, "0");
  const endDay =
    String((index % 20) + 3).padStart(2, "0");

  return {
    batchId: `double-${index}`,
    style: "ipa",
    tankNumber: 6,
    beerVolumeLiters: beerVolume,
    // Deliberately noisy historical estimate. Calibration should not need it.
    kPerHour: 0.0024 + (index % 3) * 0.0002,
    measurements: [
      {
        id: `2026-06-${day}_0800`,
        carbonation: startCarbonation,
        pressure: startPressure,
        temp: startTemperature,
      },
      {
        id: `2026-06-${endDay}_0800`,
        carbonation:
          prediction.predictedCarbonation,
        pressure:
          prediction.predictedPressure,
        temp: endTemperature,
      },
    ],
  };
}

test("V9 multi-round calibration can recover a lower double-tank effective volume on unseen batches", () => {
  const batches = Array.from(
    { length: 60 },
    (_, index) => syntheticDoubleBatch(index),
  );

  const calibration = calibratePressureV9({
    batches,
    seed: 424242,
  });

  assert.ok(calibration);
  assert.ok(calibration.rounds.length >= 5);
  assert.ok(
    calibration.calibratedParams
      .vesselVolumeByTankClass.double >= 2650 &&
      calibration.calibratedParams
        .vesselVolumeByTankClass.double <= 2950,
    `expected calibrated double volume near 2800L, got ${calibration.calibratedParams.vesselVolumeByTankClass.double}`,
  );
  assert.ok(
    calibration.calibratedParams.kPerHour > 0.002 &&
      calibration.calibratedParams.kPerHour < 0.005,
    `expected calibrated k near synthetic truth, got ${calibration.calibratedParams.kPerHour}`,
  );
  assert.ok(
    calibration.calibratedLockedTest
      .carbonationMae !== null,
  );
  assert.ok(
    calibration.currentV9LockedTest
      .carbonationMae !== null,
  );
  assert.ok(
    calibration.calibratedLockedTest
      .carbonationMae! <
      calibration.currentV9LockedTest
        .carbonationMae!,
    "calibration should improve the untouched locked test set",
  );
});

test("V9 calibration excludes lager and hoppy from fitting but reports them", () => {
  const core = Array.from(
    { length: 36 },
    (_, index) => syntheticDoubleBatch(index),
  );
  const reportOnly = [
    {
      ...syntheticDoubleBatch(101),
      batchId: "lager-1",
      style: "לאגר",
    },
    {
      ...syntheticDoubleBatch(102),
      batchId: "hoppy-1",
      style: "הופי",
    },
  ];

  const calibration = calibratePressureV9({
    batches: [...core, ...reportOnly],
    seed: 77,
  });

  assert.ok(calibration);
  assert.equal(calibration.reportOnlyBatchCount, 2);
  assert.ok(
    calibration.excludedFromFitStyles.includes("לאגר"),
  );
  assert.ok(
    calibration.excludedFromFitStyles.includes("הופי"),
  );
});
