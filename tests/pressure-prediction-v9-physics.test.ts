import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV9,
  estimatedV9TankGeometry,
  simulateV9ActionForecast,
} from "../src/SERVICES/cellering/pressurePredictionV9Physics";
import {
  pressureV9GeometryIsActionable,
} from "../src/SERVICES/cellering/pressurePredictionV9Config";

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


test("V9 shadow forecast preserves the measured pressure until a delayed operator action actually happens", () => {
  const immediate = simulateV9ActionForecast({
    tankNumber: 16,
    beerVolumeLiters: 3000,
    startCarbonation: 2.30,
    startPressure: 1.40,
    startTemperature: 5,
    setPressure: 1.00,
    finalTemperature: 1,
    coolingHours: 24,
    kPerHour: 0.001,
    futureOperationalLossBar: 0,
    hours: 48,
    actionDelayHours: 0,
  });

  const delayed = simulateV9ActionForecast({
    tankNumber: 16,
    beerVolumeLiters: 3000,
    startCarbonation: 2.30,
    startPressure: 1.40,
    startTemperature: 5,
    setPressure: 1.00,
    finalTemperature: 1,
    coolingHours: 24,
    kPerHour: 0.001,
    futureOperationalLossBar: 0,
    hours: 48,
    actionDelayHours: 12,
  });

  assert.ok(immediate);
  assert.ok(delayed);

  assert.ok(
    Math.abs(immediate!.points[0].pressure - 1.00) < 0.001,
    "an immediate action should begin at the requested pressure",
  );
  assert.ok(
    Math.abs(delayed!.points[0].pressure - 1.40) < 0.001,
    "a delayed action must preserve the measured start pressure before the action",
  );

  const atAction = delayed!.points.find((point) => point.hour === 12);
  assert.ok(atAction);
  assert.ok(
    Math.abs(atAction!.pressure - 1.00) < 0.001,
    "the delayed pressure target should be applied at the recorded action hour",
  );
});


test("V9 blocks the known tank-16 replay when real fill volume makes geometry uncertainty dominate the pressure target", () => {
  const estimate = estimatePressureTargetV9({
    tankNumber: 16,
    beerVolumeLiters: 3388,
    currentCarbonation: 2.26,
    currentPressure: 1.44,
    currentTemperature: 6.4,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
    finalTemperature: 0.5,
    kPerHour: 0.000699,
    measurements: [
      {
        id: "2026-09-18_0900",
        temp: 1.6,
        pressure: 1.10,
        notes: "הורדת שמרים, לחץ אחרי 0.90 bar",
      },
    ],
  });

  assert.ok(estimate);
  assert.ok(estimate.targetPressure !== null);
  assert.ok(
    estimate.targetPressure! > 1.6,
    `raw target should expose the unstable nominal-geometry result, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.geometrySensitivityWidthBar !== null &&
      estimate.geometrySensitivityWidthBar > 2,
    `expected huge geometry sensitivity, got ${estimate.geometrySensitivityWidthBar}`,
  );
  assert.equal(
    pressureV9GeometryIsActionable(
      estimate.geometrySensitivityWidthBar,
    ),
    false,
    "a pressure target this sensitive to vessel volume must never be presented as actionable",
  );
});
