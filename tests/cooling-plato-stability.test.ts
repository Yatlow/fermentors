import test from "node:test";
import assert from "node:assert/strict";
import { hasStablePlatoForCooling } from "../src/SERVICES/cellering/coolingPlatoStability";

const now = new Date(2026, 9, 11, 10, 0);
const friday = { id: "2026-10-09_0900", plato: 4.2 };
const sunday = { id: "2026-10-11_0900", plato: 4.2 };

test("Friday and Sunday matching Plato qualify after 48 hours", () => {
  assert.equal(hasStablePlatoForCooling([friday, sunday], now), true);
});
test("temperature/pressure-only measurements are ignored", () => {
  assert.equal(hasStablePlatoForCooling([friday, { id: "2026-10-10_1000", temp: 18 }, sunday], now), true);
});
test("contradicting intermediate Plato blocks cooling", () => {
  assert.equal(hasStablePlatoForCooling([friday, { id: "2026-10-10_1000", plato: 3.9 }, sunday], now), false);
});
test("two readings less than 48 hours apart do not qualify", () => {
  assert.equal(hasStablePlatoForCooling([{ id: "2026-10-10_0900", plato: 4.2 }, sunday], now), false);
});
test("three identical dated Plato readings still qualify", () => {
  assert.equal(hasStablePlatoForCooling([
    { id: "2026-10-10_0800", plato: 4.2 },
    { id: "2026-10-10_1600", plato: "4.2" },
    sunday,
  ], now), true);
});
test("stale latest Plato does not qualify", () => {
  assert.equal(hasStablePlatoForCooling([friday, sunday], new Date(2026, 9, 13, 10)), false);
});
test("missing and invalid Plato readings do not count", () => {
  assert.equal(hasStablePlatoForCooling([
    friday, { id: "2026-10-10_0900", plato: "" },
    { id: "2026-10-10_1100", plato: "oops" }, sunday
  ], now), true);
});
test("only two readings with no dates or future readings do not qualify", () => {
  assert.equal(hasStablePlatoForCooling([{ plato: 4.2 }, sunday], now), false);
  assert.equal(hasStablePlatoForCooling([friday, { id: "2026-10-12_0900", plato: 4.2 }], now), false);
});
