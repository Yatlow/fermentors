import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPressureV4Exposure,
  buildPressureV4Samples,
  detectPressureV4T0,
} from "../src/SERVICES/cellering/pressurePredictionV4";
import type { PressureV4Measurement as Measurement } from "../src/SERVICES/cellering/pressurePredictionV4";

function row(
  id: string,
  pressure?: number,
  temp?: number,
  carbonation?: number,
  notes?: string,
): Measurement {
  return { id, pressure, temp, carbonation, notes };
}

test("V4 T0 prefers an explicit pressure-close event", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0, 18),
    row("2026-09-02_0800", 0.2, 17),
    row("2026-09-03_0800", 0.8, 15, undefined, "סגירת לחץ"),
  ];

  const t0 = detectPressureV4T0(measurements);
  assert.ok(t0);
  assert.equal(t0.source, "explicit_close");
  assert.equal(t0.pressure, 0.8);
  assert.equal(t0.previousPressure, 0.2);
});

test("V4 T0 falls back to first meaningful positive pressure", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0, 18),
    row("2026-09-02_0800", 0.05, 17),
    row("2026-09-03_0800", 0.2, 16),
  ];

  const t0 = detectPressureV4T0(measurements);
  assert.ok(t0);
  assert.equal(t0.source, "first_positive_pressure");
  assert.equal(t0.pressure, 0.2);
});

test("V4 exposure integrates pressure history from T0", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 1, 10),
    row("2026-09-02_0800", 1.2, 6),
    row("2026-09-03_0800", 0.8, 2),
  ];

  const start = new Date(2026, 8, 1, 8).getTime();
  const end = new Date(2026, 8, 3, 8).getTime();
  const exposure = buildPressureV4Exposure({
    measurements,
    t0Ms: start,
    endMs: end,
    equilibriumPressure: (temp) => temp !== null ? 0.8 : null,
  });

  assert.equal(exposure.hoursSinceT0, 48);
  assert.equal(Number(exposure.pressureMean?.toFixed(2)), 1.1);
  assert.equal(Number(exposure.equilibriumDeltaBarHours?.toFixed(1)), 14.4);
  assert.equal(exposure.coverageRatio, 1);
});

test("V4 sample uses pressure before the action and day-2 carbonation as outcome", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0, 18),
    row("2026-09-02_0800", 0.8, 15, undefined, "סגירת לחץ"),
    row("2026-09-03_0800", 1.2, 8),
    row("2026-09-04_0800", 1.4, 6, 2.26),
    row("2026-09-04_0900", 1.1, 6, 2.26, "הורדת לחץ ל1.1 bar"),
    row("2026-09-05_0800", 1.1, 3, 2.34),
    row("2026-09-06_0800", 1.08, 2, 2.45),
  ];

  const samples = buildPressureV4Samples({
    measurements,
    batchId: "1600",
    style: "IPA",
    equilibriumPressure: () => 0.8,
  });

  assert.equal(samples.length, 1);
  assert.equal(samples[0].currentPressure, 1.4);
  assert.equal(samples[0].targetPressure, 1.1);
  assert.equal(samples[0].carbonationBefore, 2.26);
  assert.equal(samples[0].intermediateDay1?.carbonation, 2.34);
  assert.equal(samples[0].primaryOutcome.carbonation, 2.45);
  assert.equal(Number(samples[0].carbonationDelta.toFixed(2)), 0.19);
});

test("V4 rejects ordinary-pressure training sample if pressure changes again before day 2", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0.8, 12, undefined, "סגירת לחץ"),
    row("2026-09-02_0800", 1.4, 6, 2.26),
    row("2026-09-02_0900", 1.1, 6, 2.26, "הורדת לחץ ל1.1 bar"),
    row("2026-09-03_0900", 0.9, 3, undefined, "הורדת לחץ ל0.9 bar"),
    row("2026-09-04_0900", 0.9, 2, 2.45),
  ];

  assert.equal(buildPressureV4Samples({ measurements }).length, 0);
});

test("V4 rejects ordinary-pressure training sample if bottom carbonation occurs before outcome", () => {
  const measurements: Measurement[] = [
    row("2026-09-01_0800", 0.8, 12, undefined, "סגירת לחץ"),
    row("2026-09-02_0800", 1.4, 6, 2.1),
    row("2026-09-02_0900", 1.1, 6, 2.1, "הורדת לחץ ל1.1 bar"),
    row(
      "2026-09-03_1000",
      0.8,
      3,
      undefined,
      "הורדת לחץ ל0.2 bar. תחילת גיזוז מלמטה בשעה 10:00 | סגירת גיזוז מלמטה בשעה 10:45 על 0.8 bar.",
    ),
    row("2026-09-04_0900", 0.8, 2, 2.4),
  ];

  assert.equal(buildPressureV4Samples({ measurements }).length, 0);
});
