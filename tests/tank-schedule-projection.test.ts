import assert from "node:assert/strict";
import test from "node:test";
import { changedTankSchedules, projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";
import { packagingCyclesAt, tankAvailableForBrewAt } from "../src/SERVICES/planning/tankSchedule";
import type { Settings, WeekPlan } from "../src/SERVICES/planning/planningEngine";

const settings: Settings = {
  products: [
    { id: "ipa-kegs", style: "IPA", type: "kegs", sku: "IPA K", monthly: 100, tempo: 0, tempoDate: "", leadDays: 21 },
    { id: "ipa-crates", style: "IPA", type: "crates", sku: "IPA B", monthly: 100, tempo: 0, tempoDate: "", leadDays: 21 },
  ],
  targetWeeks: 2, preferredRuns: 3, lossPercent: 10, revision: 0,
};
const week = (id: string): WeekPlan => ({ id, revision: 0, packaging: [], brews: [], note: "", maxRuns: 3 });

test("projects several future brews on the same physical fermentor", () => {
  const w1 = week("2026-11-01");
  w1.brews = [{ id: "b1604", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1604" }];
  const w2 = week("2026-11-29");
  w2.brews = [{ id: "b1612", style: "IPA", tankId: "tank9", date: "2026-11-30", liters: 3000, batchNumber: "1612" }];
  const schedule = projectTankSchedules([w1, w2], settings).get("tank9")!;
  assert.deepEqual(schedule.map((cycle) => cycle.plannedBatchNumber), ["1604", "1612"]);
});

test("future packaging attaches to its future batch before that beer exists physically", () => {
  const brewWeek = week("2026-11-01");
  brewWeek.brews = [{ id: "b1604", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1604" }];
  const packWeek = week("2026-11-22");
  packWeek.packaging = [
    { id: "p1", productId: "ipa-kegs", quantity: 100, tankId: "tank9", batchNumber: "1604", date: "2026-11-24" },
    { id: "p2", productId: "ipa-crates", quantity: 40, tankId: "tank9", batchNumber: "1604", date: "2026-11-26", emptyTank: true },
  ];
  const [cycle] = projectTankSchedules([brewWeek, packWeek], settings).get("tank9")!;
  assert.equal(cycle.packaging.length, 2);
  assert.equal(cycle.emptyDate, "2026-11-26");
});

test("legacy dated packaging binds to the latest started cycle, never a later reuse", () => {
  const w1 = week("2026-11-01");
  w1.brews = [{ id: "b1604", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1604" }];
  const w2 = week("2026-11-29");
  w2.brews = [{ id: "b1612", style: "IPA", tankId: "tank9", date: "2026-11-30", liters: 3000, batchNumber: "1612" }];
  w1.packaging = [{ id: "legacy", productId: "ipa-kegs", quantity: 100, tankId: "tank9", date: "2026-11-24", emptyTank: true }];
  const schedule = projectTankSchedules([w1, w2], settings).get("tank9")!;
  assert.equal(schedule[0].packaging[0].planId, "legacy");
  assert.equal(schedule[1].packaging.length, 0);
});


test("cycle identity survives forecast batch renumbering after cancellation", () => {
  const before = week("2026-11-01");
  before.brews = [{ id: "stable-brew-id", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1605" }];
  const after = week("2026-11-01");
  after.brews = [{ id: "stable-brew-id", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1604" }];
  const first = projectTankSchedules([before], settings).get("tank9")![0];
  const renumbered = projectTankSchedules([after], settings).get("tank9")![0];
  assert.equal(first.cycleId, renumbered.cycleId);
  assert.equal(first.plannedBatchNumber, "1605");
  assert.equal(renumbered.plannedBatchNumber, "1604");
  assert.equal(first.batchNumber, undefined);
  assert.equal(renumbered.batchNumber, undefined);
});


test("moving future IPA 1677 from tank 10 to tank 17 moves the same cycle and its packaging", () => {
  const brewWeek = week("2027-04-04");
  brewWeek.brews = [{ id: "brew-ipa-1677", style: "IPA", tankId: "tank10", date: "2027-04-05", liters: 4000, batchNumber: "1677" }];
  const packWeek = week("2027-04-25");
  packWeek.packaging = [{ id: "pack-1677", productId: "ipa-kegs", quantity: 100, tankId: "tank10", batchNumber: "1677", date: "2027-04-27", emptyTank: true }];

  const before = projectTankSchedules([brewWeek, packWeek], settings);
  const beforeCycle = before.get("tank10")![0];

  const movedBrewWeek = structuredClone(brewWeek);
  movedBrewWeek.brews[0].tankId = "tank17";
  const movedPackWeek = structuredClone(packWeek);
  movedPackWeek.packaging[0].tankId = "tank17";
  const after = projectTankSchedules([movedBrewWeek, movedPackWeek], settings);
  const afterCycle = after.get("tank17")![0];

  assert.equal(beforeCycle.cycleId, "brew-ipa-1677");
  assert.equal(afterCycle.cycleId, beforeCycle.cycleId);
  assert.equal(afterCycle.plannedBatchNumber, "1677");
  assert.equal(afterCycle.packaging[0].planId, "pack-1677");
  assert.equal(after.get("tank10"), undefined);
});

test("availability selectors see later reuse and future packaging from the projected timeline", () => {
  const first = week("2026-11-01");
  first.brews = [{ id: "b1604", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1604" }];
  first.packaging = [{ id: "empty1604", productId: "ipa-kegs", quantity: 100, tankId: "tank9", batchNumber: "1604", date: "2026-11-26", emptyTank: true }];
  const second = week("2026-11-29");
  second.brews = [{ id: "b1612", style: "IPA", tankId: "tank9", date: "2026-11-30", liters: 3000, batchNumber: "1612" }];
  second.packaging = [{ id: "empty1612", productId: "ipa-kegs", quantity: 100, tankId: "tank9", batchNumber: "1612", date: "2026-12-24", emptyTank: true }];

  const schedules = projectTankSchedules([first, second], settings);
  const tank9 = schedules.get("tank9")!;
  assert.equal(tankAvailableForBrewAt(tank9, "2026-11-27"), true);
  assert.equal(tankAvailableForBrewAt(tank9, "2026-12-10"), false);
  assert.deepEqual(packagingCyclesAt(schedules, "IPA", "2026-12-22").map((item) => item.cycle.plannedBatchNumber), ["1612"]);
});


test("week 44 emptying makes tanks 18, 2 and 9 available for week 45", () => {
  const week44 = week("2026-10-25");
  week44.brews = [
    { id: "current-18", style: "IPA", tankId: "tank18", date: "2026-10-01", liters: 4000, batchNumber: "1701" },
    { id: "current-2", style: "IPA", tankId: "tank2", date: "2026-10-02", liters: 1300, batchNumber: "1702" },
    { id: "current-9", style: "IPA", tankId: "tank9", date: "2026-10-03", liters: 4000, batchNumber: "1703" },
  ];
  week44.packaging = [
    { id: "empty-18", productId: "ipa-kegs", quantity: 100, tankId: "tank18", batchNumber: "1701", date: "2026-10-29", emptyTank: true },
    { id: "empty-2", productId: "ipa-kegs", quantity: 50, tankId: "tank2", batchNumber: "1702", date: "2026-10-29", emptyTank: true },
    { id: "empty-9", productId: "ipa-kegs", quantity: 100, tankId: "tank9", batchNumber: "1703", date: "2026-10-29", emptyTank: true },
  ];
  const schedules = projectTankSchedules([week44], settings);
  for (const tankId of ["tank18", "tank2", "tank9"]) {
    assert.equal(tankAvailableForBrewAt(schedules.get(tankId)!, "2026-11-02"), true, tankId);
  }
});

test("week 45 reuse is represented without losing the week 44 release", () => {
  const week44 = week("2026-10-25");
  week44.brews = [{ id: "old-9", style: "IPA", tankId: "tank9", date: "2026-10-03", liters: 4000, batchNumber: "1703" }];
  week44.packaging = [{ id: "empty-old-9", productId: "ipa-kegs", quantity: 100, tankId: "tank9", batchNumber: "1703", date: "2026-10-29", emptyTank: true }];
  const week45 = week("2026-11-01");
  week45.brews = [{ id: "new-9", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 4000, batchNumber: "1707" }];
  const schedules = projectTankSchedules([week44, week45], settings);
  const tank9 = schedules.get("tank9")!;
  assert.equal(tank9.length, 2);
  assert.equal(tank9[0].emptyDate, "2026-10-29");
  assert.equal(tankAvailableForBrewAt(tank9, "2026-10-30"), true);
  assert.equal(tankAvailableForBrewAt(tank9, "2026-11-02"), false);
  assert.equal(tank9[1].cycleId, "new-9");
});


test("persistence diff writes only tanks whose projected lifecycle changed", () => {
  const beforeWeek = week("2026-11-01");
  beforeWeek.brews = [
    { id: "brew9", style: "IPA", tankId: "tank9", date: "2026-11-02", liters: 3000, batchNumber: "1604" },
    { id: "brew18", style: "IPA", tankId: "tank18", date: "2026-11-03", liters: 3000, batchNumber: "1605" },
  ];
  const afterWeek = structuredClone(beforeWeek);
  afterWeek.brews[0].tankId = "tank17";

  const changed = changedTankSchedules(
    projectTankSchedules([beforeWeek], settings),
    projectTankSchedules([afterWeek], settings),
  );
  assert.deepEqual(changed.map((item) => item.tankId), ["tank17", "tank9"]);
  assert.equal(changed.find((item) => item.tankId === "tank9")!.cycles.length, 0);
  assert.equal(changed.some((item) => item.tankId === "tank18"), false);
});
