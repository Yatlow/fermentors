import test from "node:test";
import assert from "node:assert/strict";
import { projectPlatoThresholdRecheck } from "../src/SERVICES/cellering/platoThresholdForecast";

const specs = { tolorances: { dryHopMinPlato: 8, shutTankMinPlato: 5 } };
const fermentor = (beerStyle: string, stage = "בתסיסה") => ({
  id: "tank-10", tankNumber: "10", beerStyle, stage: { name: stage },
});

test("IPA Plato trend projects a conditional recheck, not an automatic dry hop", () => {
  const result = projectPlatoThresholdRecheck(fermentor("IPA"), [
    { id: "2026-10-08_0800", plato: 10 },
    { id: "2026-10-09_0800", plato: 9 },
  ], "2026-10-09", specs);
  assert.equal(result.length, 1);
  assert.equal(result[0].dueDate, "2026-10-11");
  assert.match(result[0].basis, /טמפרטורה ולחץ/);
});

test("does not project thresholds from stale or flat Plato readings", () => {
  const tank = fermentor("IPA");
  assert.deepEqual(projectPlatoThresholdRecheck(tank, [
    { id: "2026-10-01_0800", plato: 10 },
    { id: "2026-10-02_0800", plato: 9 },
  ], "2026-10-09", specs), []);
  assert.deepEqual(projectPlatoThresholdRecheck(tank, [
    { id: "2026-10-08_0800", plato: 9 },
    { id: "2026-10-09_0800", plato: 9 },
  ], "2026-10-09", specs), []);
});

test("stops projecting a completed action and avoids non-fermenting tanks", () => {
  assert.deepEqual(projectPlatoThresholdRecheck(fermentor("IPA"), [
    { id: "2026-10-08_0800", plato: 10 },
    { id: "2026-10-09_0800", plato: 9, notes: "כשות" },
  ], "2026-10-09", specs), []);
  assert.deepEqual(projectPlatoThresholdRecheck(fermentor("IPA", "קר"), [
    { id: "2026-10-08_0800", plato: 10 },
    { id: "2026-10-09_0800", plato: 9 },
  ], "2026-10-09", specs), []);
});
