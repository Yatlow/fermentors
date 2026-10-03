import assert from "node:assert/strict";
import test from "node:test";
import { tankCycleAt, upsertTankScheduleCycle, validateTankSchedule, type TankScheduleCycle } from "../src/SERVICES/planning/tankSchedule";

const cycle = (cycleId: string, batchNumber: string, brewDate: string, emptyDate: string): TankScheduleCycle => ({
  cycleId, plannedBatchNumber: batchNumber, style: "IPA", brewDate, readyDate: brewDate, emptyDate, status: "planned", packaging: [],
});

test("one tank can hold several future occupancy slots", () => {
  const schedule = [
    cycle("t9:1600", "1600", "2026-09-01", "2026-10-28"),
    cycle("t9:1604", "1604", "2026-11-02", "2026-11-26"),
    cycle("t9:1612", "1612", "2026-11-30", "2026-12-24"),
  ];
  assert.deepEqual(validateTankSchedule(schedule), []);
  assert.equal(tankCycleAt(schedule, "2026-11-20")?.plannedBatchNumber, "1604");
  assert.equal(tankCycleAt(schedule, "2026-12-10")?.plannedBatchNumber, "1612");
});

test("future packaging may be committed before the beer is actually brewed", () => {
  const planned = { ...cycle("t9:1604", "1604", "2026-11-02", "2026-11-26"), readyDate: "2026-11-23",
    packaging: [{ planId: "pack-1604", productId: "ipa-kegs", quantity: 100, date: "2026-11-24" }] };
  assert.deepEqual(validateTankSchedule([planned]), []);
});

test("overlapping physical occupancies are rejected", () => {
  const first = cycle("t9:1604", "1604", "2026-11-02", "2026-11-26");
  const second = cycle("t9:1612", "1612", "2026-11-20", "2026-12-20");
  assert.equal(validateTankSchedule([first, second]).length, 1);
  assert.throws(() => upsertTankScheduleCycle([first], second));
});

test("packaging is lifecycle-bound and cannot leak into a reused tank", () => {
  const first = cycle("t9:1604", "1604", "2026-11-02", "2026-11-26");
  first.packaging = [{ planId: "old", productId: "ipa-kegs", quantity: 100, date: "2026-12-02" }];
  const second = cycle("t9:1612", "1612", "2026-11-30", "2026-12-24");
  assert.ok(validateTankSchedule([first, second]).some((item) => item.cycleId === "t9:1604"));
});
