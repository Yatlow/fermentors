import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV9,
  estimatedV9TankGeometry,
} from "../src/SERVICES/cellering/pressurePredictionV9Physics";

test("V9 maps estimated vessel geometry by production tank class", () => {
  assert.deepEqual(
    estimatedV9TankGeometry(2),
    { tankClass: "single", totalVolumeLiters: 1300 },
  );
  assert.deepEqual(
    estimatedV9TankGeometry(5),
    { tankClass: "double", totalVolumeLiters: 3000 },
  );
  assert.deepEqual(
    estimatedV9TankGeometry(16),
    { tankClass: "triple", totalVolumeLiters: 4000 },
  );
});

test("V9 closed-tank mass balance puts the known IPA replay near 1.15 bar when the cold yeast drop already happened", () => {
  const estimate = estimatePressureTargetV9({
    tankNumber: 16,
    beerVolumeLiters: 3000,
    currentCarbonation: 2.27,
    currentPressure: 1.44,
    currentTemperature: 6.4,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    finalTemperature: 0.5,
    kPerHour: 0.0025,
    measurements: [
      {
        id: "2026-09-16_0800",
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-09-18_0900",
        temp: 1.6,
        pressure: 1.10,
        notes: "הורדת שמרים, לחץ אחרי 0.90 bar",
      },
    ],
  });

  assert.ok(estimate);
  assert.equal(estimate.expectedFutureYeastDrops, 0);
  assert.equal(estimate.action, "lower");
  assert.ok(estimate.targetPressure !== null);
  assert.ok(
    estimate.targetPressure! >= 1.10 &&
      estimate.targetPressure! <= 1.22,
    `expected physical target around 1.15 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.targetFinalCarbonation !== null &&
      Math.abs(estimate.targetFinalCarbonation - 2.45) < 0.01,
    `final equilibrium should hit target, got ${estimate.targetFinalCarbonation}`,
  );
  assert.ok(
    estimate.targetFinalPressure !== null &&
      Math.abs(estimate.targetFinalPressure - 0.56) < 0.08,
    `final equilibrium pressure should be around packaging equilibrium, got ${estimate.targetFinalPressure}`,
  );
});

test("V9 exposes geometry sensitivity instead of pretending estimated tank volume is exact", () => {
  const estimate = estimatePressureTargetV9({
    tankNumber: 16,
    beerVolumeLiters: 3000,
    currentCarbonation: 2.27,
    currentPressure: 1.44,
    currentTemperature: 6.4,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    finalTemperature: 0.5,
    measurements: [],
  });

  assert.ok(estimate);
  assert.ok(estimate.geometrySensitivityLowBar !== null);
  assert.ok(estimate.geometrySensitivityHighBar !== null);
  assert.ok(
    estimate.geometrySensitivityHighBar! >
      estimate.geometrySensitivityLowBar!,
  );
  assert.ok(
    estimate.geometrySensitivityWidthBar !== null &&
      estimate.geometrySensitivityWidthBar > 0.1,
    "rough vessel-volume estimates should surface a non-trivial pressure uncertainty",
  );
});

test("V9 refuses impossible headspace geometry", () => {
  const estimate = estimatePressureTargetV9({
    tankNumber: 2,
    beerVolumeLiters: 1290,
    currentCarbonation: 2.20,
    currentPressure: 1.0,
    currentTemperature: 4,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "insufficient_geometry");
  assert.equal(estimate.targetPressure, null);
});
