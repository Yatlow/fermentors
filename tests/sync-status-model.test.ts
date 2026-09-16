import { test } from "node:test";
import assert from "node:assert/strict";
import { missingDailyMeasurementFields } from "../src/SERVICES/dashboard/healthModel";

test("a note-only row never completes pressure or temperature", () => {
  const today = new Date(2026, 8, 16, 12, 0, 0);
  const missing = missingDailyMeasurementFields(
    [{ id: "2026-09-16_0500", notes: "smoke test" }],
    false,
    today,
  );
  assert.deepEqual(missing, ["temp", "pressure"]);
});

test("zero pressure is a valid completed reading", () => {
  const today = new Date(2026, 8, 16, 12, 0, 0);
  const missing = missingDailyMeasurementFields(
    [{ id: "2026-09-16_0500", temp: 4.1, pressure: 0 }],
    false,
    today,
  );
  assert.deepEqual(missing, []);
});
