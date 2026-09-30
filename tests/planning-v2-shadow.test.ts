import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningTimelineV2 } from "../src/SERVICES/planning/planningTimelineV2";
import type { Settings, Tank, TankInput, WeekPlan } from "../src/SERVICES/planning/planningEngine";

const settings: Settings = {
  revision: 1, targetWeeks: 5, totalTargetWeeks: 8.5, preferredRuns: 4, lossPercent: 10,
  products: [
    { id: "ipa-kegs", sku: "ipa-kegs", style: "IPA", type: "kegs", monthly: 0, tempo: 0, tempoDate: "2026-09-30", leadDays: 21 },
    { id: "ipa-crates", sku: "ipa-crates", style: "IPA", type: "crates", monthly: 0, tempo: 0, tempoDate: "2026-09-30", leadDays: 21 },
  ],
};
const source = (id: string, tankNumber: number): TankInput => ({ id, tankNumber, beerStyle: "IPA", brewDate: "01/09/2026", beerVolume: 4000, batchNumber: 1600, tankStatus: false });
const tank = (id: string, number: string): Tank => ({ id, number, style: "IPA", batch: "1600", brewed: "2026-09-01", ready: "2026-09-22", liters: 3000, cold: true });
const week = (id: string, packaging: WeekPlan["packaging"] = [], brews: WeekPlan["brews"] = []): WeekPlan => ({ id, revision: 1, packaging, brews, note: "", maxRuns: 4 });

test("V2 keeps a week-44 emptying visible when reasoning about the future", () => {
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [],
    plans: [week("2026-10-25", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-28", tankId: "tank-9", emptyTank: true }])],
  });
  const current = timeline.occupancies.find((x) => x.id.startsWith("actual:"));
  assert.equal(current?.expectedEmptyAt, "2026-10-28");
});

test("historical packaging from a previous tank lifecycle cannot empty the current batch", () => {
  const currentTank = tank("tank-9", "9");
  currentTank.brewed = "2026-09-20";
  currentTank.batch = "1600";
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [currentTank], actuals: [],
    plans: [week("2026-09-13", [{ productId: "ipa-kegs", quantity: 150, date: "2026-09-18", tankId: "tank-9", emptyTank: true }])],
  });
  const current = timeline.occupancies.find((x) => x.id.startsWith("actual:"));
  assert.equal(current?.expectedEmptyAt, undefined);
  assert.equal(current?.packaging.length, 0);
});

test("future brew remains an occupancy of the physical tank and can own later packaging", () => {
  const plans = [
    week("2026-10-04", [], [{ id: "brew-1604", style: "IPA", tankId: "tank-9", date: "2026-10-05", liters: 3000, batchNumber: "1604" }]),
    week("2026-10-25", [{ productId: "ipa-crates", quantity: 252, date: "2026-10-28", tankId: "tank-9", batchNumber: "1604", emptyTank: true }]),
  ];
  const timeline = buildPlanningTimelineV2({ today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [], plans });
  const future = timeline.occupancies.find((x) => x.id === "planned:brew-1604");
  assert.equal(future?.tankId, "tank-9");
  assert.equal(future?.batchNumber, "1604");
  assert.equal(future?.expectedEmptyAt, "2026-10-28");
  assert.equal(future?.packaging.length, 1);
});

test("several physical tanks can carry independent cross-week release timelines", () => {
  const ids = [["tank-2",2],["tank-9",9],["tank-18",18]] as const;
  const packaging = ids.map(([id,n], i) => ({ productId: "ipa-kegs", quantity: 150, date: `2026-10-${String(26+i).padStart(2,"0")}`, tankId: id, emptyTank: true }));
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings,
    sources: ids.map(([id,n]) => source(id,n)), tanks: ids.map(([id,n]) => tank(id,String(n))), actuals: [],
    plans: [week("2026-10-25", packaging)],
  });
  assert.deepEqual(ids.map(([id]) => timeline.occupancies.find((x) => x.tankId === id)?.expectedEmptyAt), ["2026-10-26","2026-10-27","2026-10-28"]);
});
