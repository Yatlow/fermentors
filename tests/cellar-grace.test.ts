import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FERMENTATION_GRACE_MS,
  GRACE_RESET_HOUR,
  fermentationGraceEnd,
  graceDayStart,
  measurementGraceTankIds,
  isInInitialMeasurementGrace,
  elapsedFermentationHours,
  graceElapsedLabel,
  completedDailyRoundKpi,
  shouldShowPlatoPhTank,
} from "../src/SERVICES/dashboard/cellarGrace";

const fullyMeasured = { temp: true, pressure: true, plato: true, pH: true };
const missingPH = { ...fullyMeasured, pH: false };
const veterans = Array.from({ length: 14 }, (_, index) => ({
  id: `v${index + 2}`,
  tankNumber: index + 2,
  action: 1,
  stage: { name: "בתסיסה" },
  currentData: { temp: 15 },
}));
const fullVeteranFields = Object.fromEntries(veterans.map(tank => [tank.id, fullyMeasured]));
const newTank = (started: Date) => ({
  id: "tank16", tankNumber: 16, action: 1,
  stage: { name: "בתסיסה" }, currentData: { temp: 17 },
  fermentationStartedAt: started.toISOString(),
});
const allTanks = (started: Date) => [...veterans, newTank(started)];
const exempt = (started: Date, at: Date, fields = fullVeteranFields) =>
  measurementGraceTankIds(allTanks(started), fields, at).has("tank16");

test("04:00 is the grace-day boundary, without changing ordinary calendar days", () => {
  assert.equal(GRACE_RESET_HOUR, 4);
  assert.equal(graceDayStart(new Date(2026, 9, 16, 0)).getDate(), 15);
  assert.equal(graceDayStart(new Date(2026, 9, 16, 3, 59)).getDate(), 15);
  assert.equal(graceDayStart(new Date(2026, 9, 16, 4)).getDate(), 16);
  assert.equal(graceDayStart(new Date(2026, 9, 16, 4)).getHours(), 4);
});

test("12 hours are an unconditional minimum, including midnight and 04:00", () => {
  const start = new Date(2026, 9, 15, 22);
  const tank = newTank(start);
  assert.equal(fermentationGraceEnd(tank), start.getTime() + FERMENTATION_GRACE_MS);
  assert.equal(isInInitialMeasurementGrace(tank, new Date(2026, 9, 16, 4, 59)), true);
  assert.equal(exempt(start, new Date(2026, 9, 16, 4), {}), true);
  assert.equal(exempt(start, new Date(2026, 9, 16, 9, 59), {}), true);
  assert.equal(isInInitialMeasurementGrace(tank, new Date(2026, 9, 16, 10)), false);
});

test("a completed veteran round grants optional grace after the initial 12 hours", () => {
  const start = new Date(2026, 9, 15, 8);
  const at = new Date(2026, 9, 15, 21);
  assert.equal(exempt(start, at), true);
  assert.equal(exempt(start, at, { ...fullVeteranFields, v7: missingPH }), false);
  assert.equal(exempt(start, at, {}), false, "missing history is not a completed round");
});

test("completion can grant grace retroactively within the same 04:00 cycle", () => {
  const start = new Date(2026, 9, 15, 8);
  const at = new Date(2026, 9, 15, 22);
  assert.equal(exempt(start, at, {}), false);
  assert.equal(exempt(start, at), true);
});

test("grace persists after midnight based on the previous calendar day's veteran measurements", () => {
  const start = new Date(2026, 9, 15, 8);
  const at = new Date(2026, 9, 16, 3, 59);
  assert.equal(graceDayStart(at).getDate(), 15);
  assert.equal(exempt(start, at, fullVeteranFields), true);
  assert.equal(exempt(start, at, {}), false);
});

test("a new complete round after midnight also grants grace, without mixing partial days", () => {
  const start = new Date(2026, 9, 15, 8);
  const at = new Date(2026, 9, 16, 2);
  const tanks = allTanks(start);
  assert.equal(measurementGraceTankIds(tanks, {}, at, fullVeteranFields).has("tank16"), true);
  const firstSeven = Object.fromEntries(veterans.slice(0, 7).map(v => [v.id, fullyMeasured]));
  const lastSeven = Object.fromEntries(veterans.slice(7).map(v => [v.id, fullyMeasured]));
  assert.equal(measurementGraceTankIds(tanks, firstSeven, at, lastSeven).has("tank16"), false);
});

test("a tank becomes veteran at the next 04:00 after its original 12 hours ended", () => {
  const start = new Date(2026, 9, 15, 8); // Grace ends 20:00
  assert.equal(exempt(start, new Date(2026, 9, 16, 3, 59)), true);
  assert.equal(exempt(start, new Date(2026, 9, 16, 4)), false);
});

test("when 12 hours expire after 04:00, today's veteran round controls grace until tomorrow 04:00", () => {
  const start = new Date(2026, 9, 15, 21); // 12 hours end at 09:00 next day
  assert.equal(exempt(start, new Date(2026, 9, 16, 8, 59), {}), true);
  assert.equal(exempt(start, new Date(2026, 9, 16, 9), {}), false);
  assert.equal(exempt(start, new Date(2026, 9, 16, 9), fullVeteranFields), true);
  assert.equal(exempt(start, new Date(2026, 9, 17, 3, 59)), true);
  assert.equal(exempt(start, new Date(2026, 9, 17, 4)), false);
});

test("only the veterans decide: multiple new tanks cannot block each other", () => {
  const at = new Date(2026, 9, 15, 21);
  const newlyStarted = new Date(2026, 9, 15, 8);
  const tanks = [...veterans, newTank(newlyStarted), {
    ...newTank(newlyStarted), id: "tank17", tankNumber: 17,
  }];
  const ids = measurementGraceTankIds(tanks, fullVeteranFields, at);
  assert.deepEqual([...ids].sort(), ["tank16", "tank17"]);
  assert.equal(measurementGraceTankIds(tanks, { ...fullVeteranFields, v3: missingPH }, at).size, 0);
});

test("a cold veteran only needs temperature and pressure; a hot veteran needs pH too", () => {
  const start = new Date(2026, 9, 15, 8);
  const coldVeteran = { ...veterans[0], stage: { name: "קר" }, currentData: { temp: 5 } };
  const fields = { ...fullVeteranFields, [coldVeteran.id]: missingPH };
  assert.equal(measurementGraceTankIds([coldVeteran, ...veterans.slice(1), newTank(start)], fields, new Date(2026, 9, 15, 22)).has("tank16"), true);
  assert.equal(exempt(start, new Date(2026, 9, 15, 22), { ...fullVeteranFields, v2: missingPH }), false);
});

test("inactive, missing-date and future tanks never get optional grace", () => {
  const at = new Date(2026, 9, 15, 10);
  const future = newTank(new Date(2026, 9, 16));
  assert.equal(measurementGraceTankIds([future], {}, at).size, 0);
  assert.equal(measurementGraceTankIds([{ ...newTank(at), action: 3 }], {}, at).size, 0);
  assert.equal(measurementGraceTankIds([{ id: "bad", tankNumber: 17, action: 1 }], {}, at).size, 0);
});

test("legacy Firestore extension snapshots no longer change grace classification", () => {
  const start = new Date(2026, 9, 13, 8);
  const legacy = {
    id: "tank1", tankNumber: 1,
    cellarGraceExtensions: { tank16: new Date(2026, 9, 20).toISOString() },
    cellarGraceTankIds: ["tank16"], cellarHealthCompletedDay: "2026-10-15",
  };
  const result = measurementGraceTankIds([...veterans, newTank(start), legacy], fullVeteranFields, new Date(2026, 9, 15, 22));
  assert.equal(result.has("tank16"), false);
});

test("grace timer appears only for currently exempt tanks", () => {
  const start = new Date(2026, 9, 15, 8);
  const tank = newTank(start);
  assert.equal(elapsedFermentationHours(tank, new Date(2026, 9, 16, 10, 30)), "26:30");
  assert.equal(graceElapsedLabel(tank, true, new Date(2026, 9, 15, 8, 10)), "עברו 00:10 שעות מהעברה למיכל");
  assert.equal(graceElapsedLabel(tank, true, new Date(2026, 9, 16, 4, 59)), "עברו 20:59 שעות מהעברה למיכל");
  assert.equal(graceElapsedLabel(tank, false, new Date(2026, 9, 16, 5)), null);
  assert.equal(graceElapsedLabel({ ...tank, action: 3 }, true, new Date(2026, 9, 15, 9)), null);
});

test("voluntary full grace round adds 1/1; missing/partial grace never raises required denominator", () => {
  const rows = veterans.map(tank => ({ tankNumber: String(tank.tankNumber), completeMeasurements: true }));
  const ids = new Set(["16"]);
  const noReading = completedDailyRoundKpi([...rows, { tankNumber: "16", completeMeasurements: false }], ids);
  assert.equal(noReading.checkedTanks, 14);
  assert.equal(noReading.completeMeasurementTankNumbers.length, 14);
  const voluntary = completedDailyRoundKpi([...rows, { tankNumber: "16", completeMeasurements: true }], ids);
  assert.equal(voluntary.checkedTanks, 15);
  assert.equal(voluntary.completeMeasurementTankNumbers.length, 15);
  const missingVeteran = completedDailyRoundKpi([...rows.slice(0, 13),
    { tankNumber: "15", completeMeasurements: false },
    { tankNumber: "16", completeMeasurements: false }], ids);
  assert.equal(missingVeteran.checkedTanks, 14);
  assert.equal(missingVeteran.completeMeasurementTankNumbers.length, 13);
});

test("Plato/pH tab includes a grace tank with no first temperature measurement", () => {
  const start = new Date(2026, 9, 20, 0, 26);
  const at = new Date(2026, 9, 20, 4, 20);
  const young = { ...newTank(start), currentData: { temp: undefined } };
  const graceIds = measurementGraceTankIds([...veterans, young], {}, at);
  assert.equal(graceIds.has("tank16"), true);
  assert.equal(shouldShowPlatoPhTank(young, graceIds), true);
  assert.equal(shouldShowPlatoPhTank(young, new Set()), false);
  assert.equal(shouldShowPlatoPhTank({ ...young, action: 3 }, graceIds), false);
  assert.equal(shouldShowPlatoPhTank({ ...young, stage: { name: "קר" } }, graceIds), false);
  assert.equal(shouldShowPlatoPhTank({ ...young, currentData: { temp: 19 } }, new Set()), true);
  assert.equal(shouldShowPlatoPhTank({ ...young, tankNumber: 1 }, graceIds), false);
});
