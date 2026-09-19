import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEquilibriumV4PointForBatch,
  estimateEquilibriumPressureV4,
  type PressureEquilibriumV4Curve,
} from "../src/SERVICES/cellering/pressureEquilibriumV4";
import type { Measurement } from "../src/SERVICES/cellering/calculateCelleringRecomendations";

function row(
  id: string,
  pressure?: number,
  temp?: number,
  carbonation?: number,
  notes?: string,
): Measurement {
  return { id, pressure, temp, carbonation, notes };
}

test("V4 equilibrium point comes from a stable multi-day period", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0, 18),
    row("2026-09-02_0800", 0.8, 14, undefined, "סגירת לחץ"),
    row("2026-09-03_0800", 0.82, 3.2, 2.44),
    row("2026-09-04_0800", 0.80, 2.7),
    row("2026-09-05_0800", 0.81, 2.5, 2.46),
    row("2026-09-06_0800", 0.80, 2.4),
  ];

  const point = buildEquilibriumV4PointForBatch({
    measurements,
    batchId: "1601",
    targetCarbonation: 2.45,
  });

  assert.ok(point);
  assert.ok(point.stableDays >= 3);
  assert.equal(point.quality, "high");
  assert.ok(Math.abs(point.pressure - 0.805) <= 0.02);
  assert.ok(point.temperature >= 2.4 && point.temperature <= 3.2);
});

test("V4 equilibrium rejects a window interrupted by pressure adjustment", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0.8, 12, undefined, "סגירת לחץ"),
    row("2026-09-02_0800", 0.8, 3, 2.45),
    row("2026-09-03_0800", 0.9, 3, undefined, "העלאת לחץ ל0.9 bar"),
    row("2026-09-04_0800", 0.9, 3, 2.45),
  ];

  const point = buildEquilibriumV4PointForBatch({
    measurements,
    batchId: "1602",
    targetCarbonation: 2.45,
  });

  assert.equal(point, null);
});

test("V4 style equilibrium varies smoothly with temperature from batch points", () => {
  const curve: PressureEquilibriumV4Curve = {
    style: "ipa",
    points: [
      { batchId: "a", temperature: 1, pressure: 0.72, stableDays: 4, carbonationChecks: 2, quality: "high" },
      { batchId: "b", temperature: 2, pressure: 0.78, stableDays: 4, carbonationChecks: 2, quality: "high" },
      { batchId: "c", temperature: 4, pressure: 0.88, stableDays: 4, carbonationChecks: 2, quality: "high" },
      { batchId: "d", temperature: 6, pressure: 0.98, stableDays: 4, carbonationChecks: 2, quality: "high" },
      { batchId: "e", temperature: 7, pressure: 1.04, stableDays: 4, carbonationChecks: 2, quality: "high" },
    ],
  };

  const cold = estimateEquilibriumPressureV4(curve, 1);
  const warm = estimateEquilibriumPressureV4(curve, 6);

  assert.ok(cold !== null);
  assert.ok(warm !== null);
  assert.ok(warm > cold);
});
