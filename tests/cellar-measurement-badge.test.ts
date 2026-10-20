import assert from "node:assert/strict";
import test from "node:test";
import {
  cellarBadgeFieldsForDay,
  pendingCellarMeasurementTankNumbers,
  type CellarBadgeTank,
} from "../src/SERVICES/dashboard/cellarMeasurementBadge";

const TODAY = new Date(2026, 9, 19, 13, 40);
const tank = (id: string, number: number, temp: number, extra: Partial<CellarBadgeTank> = {}): CellarBadgeTank => ({
  id, tankNumber: number, action: 1, batchNumber: String(1600 + number),
  stage: { name: temp > 9 ? "בתסיסה" : "קר" },
  currentData: { temp }, ...extra,
});

test("navigation badge and dashboard measurementRound fields agree for hot and cold tanks", () => {
  const tanks = [tank("tank-7", 7, 18), tank("tank-13", 13, 5)];
  const byTank = {
    "tank-7": cellarBadgeFieldsForDay([
      { id: "2026-10-19_0900", temp: 18.2, pressure: 0.0, plato: 5.4 },
    ], TODAY),
    "tank-13": cellarBadgeFieldsForDay([
      { id: "2026-10-19_0855", temp: 4.6, pressure: 1.6 },
    ], TODAY),
  };
  assert.deepEqual(pendingCellarMeasurementTankNumbers(tanks, byTank, [], TODAY), ["7"]);
  assert.equal(byTank["tank-7"].pH, false);
  assert.equal(byTank["tank-13"].plato, false);
  assert.equal(pendingCellarMeasurementTankNumbers(tanks, byTank, [], TODAY).length, 1,
    "a hot tank with one missing pH counts exactly once");
});

test("a new pressure report removes the badge immediately even outside the cellar screen", () => {
  const tanks = [tank("tank-4", 4, 5)];
  const before = { "tank-4": cellarBadgeFieldsForDay([{ id: "2026-10-19_0815", temp: 5 }], TODAY) };
  const after = { "tank-4": cellarBadgeFieldsForDay([
    { id: "2026-10-19_0815", temp: 5 },
    { id: "2026-10-19_1040", pressure: 1.2 },
  ], TODAY) };
  assert.deepEqual(pendingCellarMeasurementTankNumbers(tanks, before, [], TODAY), ["4"]);
  assert.deepEqual(pendingCellarMeasurementTankNumbers(tanks, after, [], TODAY), []);
});

test("ignored round matches tank and batch and does not suppress another batch", () => {
  const tanks = [tank("tank-7", 7, 16), tank("tank-8", 8, 16)];
  const byTank = {
    "tank-7": cellarBadgeFieldsForDay([], TODAY),
    "tank-8": cellarBadgeFieldsForDay([], TODAY),
  };
  const ignored = [{ tankNumber: "7", batchNumber: "1607", recommendationKey: "measurementRound" }];
  assert.deepEqual(pendingCellarMeasurementTankNumbers(tanks, byTank, ignored, TODAY), ["8"]);
  assert.deepEqual(pendingCellarMeasurementTankNumbers(tanks, byTank,
    [{ ...ignored[0], batchNumber: "previous-batch" }], TODAY), ["7", "8"]);
});

test("12-hour grace suppresses missing badge, but legacy snapshot alone cannot", () => {
  const tankOne = {
    id: "tank-1", tankNumber: 1, action: 0,
    cellarHealthCompletedDay: "2026-10-19",
    cellarGraceTankIds: ["tank-7"],
  };
  const missing = { "tank-7": cellarBadgeFieldsForDay([], TODAY) };
  const startedRecently = tank("tank-7", 7, 18, {
    fermentationStartedAt: new Date(2026, 9, 19, 8).toISOString(),
  });
  assert.deepEqual(pendingCellarMeasurementTankNumbers([tankOne, startedRecently], missing, [], TODAY), []);
  assert.deepEqual(pendingCellarMeasurementTankNumbers([tankOne, tank("tank-7", 7, 18)], missing, [], TODAY), ["7"]);
});

test("after 12 hours the conditional badge uses veteran completion in the same 05:00 grace cycle", () => {
  const checkedAt = new Date(2026, 9, 19, 22);
  const old = tank("old", 4, 15);
  const young = tank("new", 16, 15, { fermentationStartedAt: new Date(2026, 9, 19, 8).toISOString() });
  const today = { old: cellarBadgeFieldsForDay([], checkedAt), new: cellarBadgeFieldsForDay([], checkedAt) };
  const oldCompleted = { ...today, old: { temp: true, pressure: true, plato: true, pH: true } };
  assert.deepEqual(pendingCellarMeasurementTankNumbers([old, young], today, [], checkedAt), ["4", "16"]);
  assert.deepEqual(pendingCellarMeasurementTankNumbers([old, young], oldCompleted, [], checkedAt), []);

  // At 00:00, badges reset to today, but the grace decision still uses yesterday.
  const afterMidnight = new Date(2026, 9, 20, 0, 10);
  assert.deepEqual(pendingCellarMeasurementTankNumbers([old, young], today, [], afterMidnight, oldCompleted), ["4"]);
  // At 05:00, young becomes a veteran as its original 12h grace ended yesterday.
  assert.deepEqual(pendingCellarMeasurementTankNumbers([old, young], today, [], new Date(2026, 9, 20, 5), oldCompleted), ["4", "16"]);
});

test("an unloaded or inactive tank is never presumed to be missing everything", () => {
  const tanks = [tank("tank-7", 7, 18), tank("tank-8", 8, 15, { action: 3 })];
  assert.deepEqual(pendingCellarMeasurementTankNumbers(tanks, {}, [], TODAY), []);
});

test("yesterday's measurement does not clear today's navigation badge", () => {
  const rows = cellarBadgeFieldsForDay([
    { id: "2026-10-18_1800", temp: 18.0, pressure: 0, plato: 5, pH: 4.25 },
  ], TODAY);
  assert.deepEqual(pendingCellarMeasurementTankNumbers([tank("tank-7", 7, 18)], { "tank-7": rows }, [], TODAY), ["7"]);
});
