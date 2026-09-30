import assert from "node:assert/strict";
import test from "node:test";
import { projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";
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
