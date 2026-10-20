import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fermentationGraceEnd,
  graceExtensionEnd,
  graceExtensionsAtHundred,
  completedRoundGraceExtensions,
  pendingGraceExtensions,
  elapsedFermentationHours,
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

const complete = { temp: true, pressure: true, plato: true, pH: true };
const incomplete = { temp: true, pressure: false, plato: true, pH: true };
const fullRound = Array.from({ length: 14 }, (_, index) => ({
  id: `required-${index + 1}`,
  tankNumber: index + 2,
  action: 1,
  stage: { name: "בתסיסה" },
  currentData: { temp: 12 },
}));
const grace16 = { ...tank, id: "tank16", tankNumber: 16 };
const atFullRound = new Date(2026, 9, 15, 10, 30);
const allComplete = Object.fromEntries(fullRound.map(t => [t.id, complete]));

test("14/14 while tank 16 is in grace locks it until tomorrow ends, independent of Slering score", () => {
  const graceTank16 = { ...grace16, fermentationStartedAt: new Date(2026, 9, 15, 8).toISOString() };
  const eligible = [...fullRound, graceTank16, root];
  const extensions = completedRoundGraceExtensions(eligible, allComplete, root, atFullRound);
  assert.deepEqual(Object.keys(extensions), ["tank16"]);
  const locked = { ...root, cellarGraceExtensions: extensions };
  assert.equal(isInMeasurementGrace(graceTank16, locked, new Date(2026, 9, 16, 23, 59)), true);
  assert.equal(isInMeasurementGrace(graceTank16, locked, new Date(2026, 9, 17, 0, 0)), false);
  // A subsequent render, another view, or another tablet must not extend twice.
  assert.deepEqual(completedRoundGraceExtensions(eligible, allComplete, locked, atFullRound), {});
});

test("grace tank voluntarily measured or unmeasured never affects 14/14 required rounds", () => {
  const eligible = [...fullRound, { ...grace16, fermentationStartedAt: new Date(2026, 9, 15, 8).toISOString() }];
  assert.deepEqual(Object.keys(completedRoundGraceExtensions(eligible, allComplete, root, atFullRound)), ["tank16"]);
  assert.deepEqual(Object.keys(completedRoundGraceExtensions(eligible, {
    ...allComplete, tank16: complete,
  }, root, atFullRound)), ["tank16"]);
});

test("13/14, missing history or missing warm pH never locks grace", () => {
  const eligible = [...fullRound, { ...grace16, fermentationStartedAt: new Date(2026, 9, 15, 8).toISOString() }];
  assert.deepEqual(completedRoundGraceExtensions(eligible, {
    ...allComplete, "required-4": incomplete,
  }, root, atFullRound), {});
  const withMissingHistory = { ...allComplete };
  delete (withMissingHistory as Record<string, typeof complete>)["required-7"];
  assert.deepEqual(completedRoundGraceExtensions(eligible, withMissingHistory, root, atFullRound), {});
  assert.deepEqual(completedRoundGraceExtensions(eligible, {
    ...allComplete, "required-9": { ...complete, pH: false },
  }, root, atFullRound), {});
});

test("once the original grace expires before completion the new tank is required", () => {
  const graceEnded = { ...grace16, fermentationStartedAt: new Date(2026, 9, 14, 20).toISOString() };
  assert.deepEqual(completedRoundGraceExtensions([...fullRound, graceEnded], allComplete, root, atFullRound), {});
  assert.deepEqual(pendingGraceExtensions([graceEnded], root, atFullRound), {});
});

test("round completion with no required tanks cannot lock arbitrary future grace", () => {
  const fresh = { ...grace16, fermentationStartedAt: new Date(2026, 9, 15, 8).toISOString() };
  assert.deepEqual(completedRoundGraceExtensions([fresh, root], {}, root, atFullRound), {});
});

test("elapsed transfer hours is hh:mm, including after 24 hours and zero", () => {
  const start = new Date(2026, 9, 15, 8);
  const current = { ...grace16, fermentationStartedAt: start.toISOString() };
  assert.equal(elapsedFermentationHours(current, new Date(2026, 9, 15, 8)), "00:00");
  assert.equal(elapsedFermentationHours(current, new Date(2026, 9, 15, 13, 9)), "05:09");
  assert.equal(elapsedFermentationHours(current, new Date(2026, 9, 16, 10, 30)), "26:30");
  assert.equal(elapsedFermentationHours({ id: "no-time" }, atFullRound), null);
});
