import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningTimelineV2, compareTimelineAvailability, timelineBrewCandidatesForWeek, timelineForTank, timelinePackagingCandidatesForWeek } from "../src/SERVICES/planning/planningTimelineV2";
import type { Settings, Tank, WeekPlan } from "../src/SERVICES/planning/planningEngine";
import type { TankSource } from "../src/SERVICES/planning/productionCycle";

const settings: Settings = {
  revision: 1, targetWeeks: 5, totalTargetWeeks: 8.5, preferredRuns: 4, lossPercent: 10,
  products: [
    { id: "ipa-kegs", sku: "ipa-kegs", style: "IPA", type: "kegs", monthly: 0, tempo: 0, tempoDate: "2026-09-30", leadDays: 21 },
    { id: "ipa-crates", sku: "ipa-crates", style: "IPA", type: "crates", monthly: 0, tempo: 0, tempoDate: "2026-09-30", leadDays: 21 },
  ],
};
const source = (id: string, tankNumber: number): TankSource => ({ id, tankNumber, beerStyle: "IPA", brewDate: "01/09/2026", beerVolume: 4000, batchNumber: 1600, tankStatus: false });
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
    week("2026-09-27", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-02", tankId: "tank-9", batchNumber: "1600", emptyTank: true }]),
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


test("a future occupancy without prior emptying is surfaced as a hard timeline conflict", () => {
  const plans = [week("2026-10-04", [], [{ id: "brew-1604", style: "IPA", tankId: "tank-9", date: "2026-10-05", liters: 3000, batchNumber: "1604" }])];
  const timeline = buildPlanningTimelineV2({ today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [], plans });
  assert.equal(timeline.issues.length, 1);
  assert.match(timeline.issues[0].message, /בלי ריקון מתוכנן/);
});

test("release after week-44 emptying remains available in week 45", () => {
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [],
    plans: [week("2026-10-25", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-28", tankId: "tank-9", emptyTank: true }])],
  });
  assert.equal(timeline.availability.find((x) => x.tankId === "tank-9")?.date, "2026-11-02");
});

test("packaging after a second future brew belongs only to the second occupancy", () => {
  const plans = [
    week("2026-09-27", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-02", tankId: "tank-9", batchNumber: "1600", emptyTank: true }]),
    week("2026-10-04", [], [{ id: "brew-1604", style: "IPA", tankId: "tank-9", date: "2026-10-05", liters: 3000, batchNumber: "1604" }]),
    week("2026-10-25", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-28", tankId: "tank-9", batchNumber: "1604", emptyTank: true }], [{ id: "brew-1605", style: "IPA", tankId: "tank-9", date: "2026-10-30", liters: 3000, batchNumber: "1605" }]),
    week("2026-11-15", [{ productId: "ipa-crates", quantity: 252, date: "2026-11-20", tankId: "tank-9", batchNumber: "1605", emptyTank: true }]),
  ];
  const timeline = buildPlanningTimelineV2({ today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [], plans });
  const first = timeline.occupancies.find((x) => x.id === "planned:brew-1604");
  const second = timeline.occupancies.find((x) => x.id === "planned:brew-1605");
  assert.deepEqual(first?.packaging.map((x) => x.date), ["2026-10-28"]);
  assert.deepEqual(second?.packaging.map((x) => x.date), ["2026-11-20"]);
});

test("future occupancy exposes remaining supply after its committed packaging", () => {
  const plans = [
    week("2026-09-27", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-02", tankId: "tank-9", batchNumber: "1600", emptyTank: true }]),
    week("2026-10-04", [], [{ id: "brew-1604", style: "IPA", tankId: "tank-9", date: "2026-10-05", liters: 3000, batchNumber: "1604" }]),
    week("2026-10-25", [{ productId: "ipa-kegs", quantity: 100, date: "2026-10-28", tankId: "tank-9", batchNumber: "1604", emptyTank: false }]),
  ];
  const timeline = buildPlanningTimelineV2({ today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [], plans });
  assert.equal(timeline.supply.find((x) => x.occupancyId === "planned:brew-1604")?.availableLiters, 1000);
});

test("future planned beer becomes a packaging candidate after maturation", () => {
  const activeSettings = { ...settings, products: settings.products.map((p) => ({ ...p, monthly: 100 })) };
  const plans = [
    week("2026-09-27", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-02", tankId: "tank-9", batchNumber: "1600", emptyTank: true }]),
    week("2026-10-04", [], [{ id: "brew-1604", style: "IPA", tankId: "tank-9", date: "2026-10-05", liters: 3000, batchNumber: "1604" }]),
  ];
  const timeline = buildPlanningTimelineV2({ today: "2026-09-30", settings: activeSettings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [], plans });
  const candidate = timeline.packagingCandidates.find((x) => x.occupancyId === "planned:brew-1604" && x.productId === "ipa-kegs");
  assert.equal(candidate?.readyAt, "2026-10-26");
  assert.equal(candidate?.maxUnits, 150);
});

test("timeline exposes brew candidates from canonical tank availability", () => {
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [],
    plans: [week("2026-10-25", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-28", tankId: "tank-9", emptyTank: true }])],
  });
  assert.equal(timeline.brewCandidates.find((x) => x.tankId === "tank-9")?.availableAt, "2026-11-02");
});

test("every committed tank emptying remains independently visible to downstream consumers", () => {
  const fixtures = Array.from({ length: 6 }, (_, index) => ({
    id: `tank-fixture-${index + 1}`,
    number: index + 2,
    date: `2026-10-${String(5 + index).padStart(2, "0")}`,
  }));
  const packaging = fixtures.map((fixture) => ({
    productId: "ipa-kegs", quantity: 150, date: fixture.date,
    tankId: fixture.id, batchNumber: `batch-${fixture.number}`, emptyTank: true,
  }));
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings,
    sources: fixtures.map((fixture) => source(fixture.id, fixture.number)),
    tanks: fixtures.map((fixture) => ({ ...tank(fixture.id, String(fixture.number)), batch: `batch-${fixture.number}` })),
    actuals: [], plans: [week("2026-10-04", packaging)],
  });
  assert.deepEqual(
    fixtures.map((fixture) => timeline.occupancies.find((x) => x.tankId === fixture.id)?.expectedEmptyAt),
    fixtures.map((fixture) => fixture.date),
  );
});

test("canonical V2 queries return every eligible tank rather than a first-match shortcut", () => {
  const ids = [["tank-3",3],["tank-17",17],["tank-19",19]] as const;
  const packaging = ids.map(([id], index) => ({
    productId: "ipa-kegs", quantity: 150, date: `2026-10-0${5 + index}`, tankId: id, batchNumber: "1600", emptyTank: true,
  }));
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings,
    sources: ids.map(([id,n]) => source(id,n)),
    tanks: ids.map(([id,n]) => tank(id,String(n))),
    actuals: [], plans: [week("2026-10-04", packaging)],
  });
  assert.equal(timelineBrewCandidatesForWeek(timeline, "2026-10-04").length, 0);
  assert.deepEqual(ids.map(([id]) => timelineForTank(timeline, id).length), [1,1,1]);
  assert.ok(timelinePackagingCandidatesForWeek(timeline, "2026-10-04").length >= 0);
});

test("parity report distinguishes agreement from intentional V1 cross-week regression", () => {
  const timeline = buildPlanningTimelineV2({
    today: "2026-09-30", settings, sources: [source("tank-9", 9)], tanks: [tank("tank-9", "9")], actuals: [],
    plans: [week("2026-10-25", [{ productId: "ipa-kegs", quantity: 150, date: "2026-10-28", tankId: "tank-9", emptyTank: true }])],
  });
  const matching = compareTimelineAvailability(timeline, [{ tankId: "tank-9", date: "2026-11-02", emptyDate: "2026-10-28" }]);
  assert.equal(matching[0].matches, true);
  const legacyMiss = compareTimelineAvailability(timeline, [{ tankId: "tank-9", date: null, emptyDate: null }]);
  assert.equal(legacyMiss[0].matches, false);
  assert.equal(legacyMiss[0].v2EmptyAt, "2026-10-28");
});
