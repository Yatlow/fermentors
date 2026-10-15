import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fermentationGraceEnd,
  graceExtensionEnd,
  graceExtensionsAtHundred,
  isInMeasurementGrace,
} from "../src/SERVICES/dashboard/cellarGrace";

const started = new Date(2026, 9, 15, 7).toISOString();
const tank = { id: "f8", tankNumber: 8, action: 1, fermentationStartedAt: started };
const at = new Date(2026, 9, 15, 10);
const root = { id: "tank1", tankNumber: 1 };

test("hot tank remains in ordinary grace and can be exempt from required rounds", () => {
  assert.equal(isInMeasurementGrace(tank, root, at), true);
  assert.equal(isInMeasurementGrace(tank, root, new Date(2026, 9, 15, 20)), false);
});

test("100% locks tanks whose grace ends within the next 24 hours", () => {
  const overrides = graceExtensionsAtHundred([tank, root], at);
  assert.deepEqual(Object.keys(overrides), ["f8"]);
  assert.equal(Date.parse(overrides.f8), graceExtensionEnd(at));
  assert.equal(new Date(graceExtensionEnd(at)).getDate(), 17);
});

test("extended grace holds through the next day but expires at midnight afterward", () => {
  const state = { ...root, cellarGraceExtensions: graceExtensionsAtHundred([tank], at) };
  assert.equal(isInMeasurementGrace(tank, state, new Date(2026, 9, 16, 23, 59)), true);
  assert.equal(isInMeasurementGrace(tank, state, new Date(2026, 9, 17, 0, 0)), false);
});

test("old tanks and inactive tanks are never extended", () => {
  assert.deepEqual(graceExtensionsAtHundred([
    { ...tank, fermentationStartedAt: new Date(2026, 9, 13).toISOString() },
    { ...tank, id: "inactive", action: 3 },
  ], at), {});
  assert.equal(fermentationGraceEnd({ id: "missing" }), null);
});
