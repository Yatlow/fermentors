import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, defaultSettings, emptyWeek, type Product, type Tank } from "../src/SERVICES/planning/planningEngine";
import { GANTT_FUTURE_WEEKS, planningQueryEnd, planningWeekIds, simulationWeeksForPage } from "../src/SERVICES/planning/planningHorizon";
import { withStablePackagingIdentity, resolvePackagingBrewId } from "../src/SERVICES/planning/planIdentity";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { futureTanks } from "../src/SERVICES/planning/dailyPlanner";

const today = "2026-10-22";
const currentWeek = "2026-10-18";
const product: Product = {
  id: "ipa-crates", sku: "ipa-crates", style: "IPA", type: "crates",
  monthly: 10000, tempo: 0, tempoDate: today, leadDays: 21,
};

test("Gantt forecast replays every prior week on all five-week pages", () => {
  const all = planningWeekIds(currentWeek);
  assert.equal(all.length, GANTT_FUTURE_WEEKS + 1);
  const initial = all.slice(0, 5);
  const later = all.slice(4, 9);
  assert.deepEqual(simulationWeeksForPage(all, initial), initial);
  assert.deepEqual(simulationWeeksForPage(all, later), all.slice(0, 9));
  assert.deepEqual(simulationWeeksForPage(all, all.slice(-5)), all);
  assert.deepEqual(simulationWeeksForPage(all, []), []);
});

test("Firestore query includes entire final displayed Gantt week", () => {
  const all = planningWeekIds(currentWeek);
  const finalWeek = all.at(-1)!;
  assert.equal(finalWeek, addDays(currentWeek, 84));
  assert.equal(planningQueryEnd(currentWeek), addDays(finalWeek, 7));
  assert.ok(addDays(finalWeek, 6) < planningQueryEnd(currentWeek));
});

test("canonical split/final packaging retains physical tank number and exact brewId", () => {
  const brewId = "brew:ipa:future";
  const week = { ...emptyWeek(currentWeek), brews: [{
    id: brewId, tankId: "tank-doc-4", style: "IPA", date: "2026-10-19",
    liters: 1100, batchNumber: "1733",
  }] };
  const original = { ...emptyWeek("2026-11-08"), packaging: [
    { id: `weekly-pack:2026-11-08:brew:${brewId}:ipa-crates:drain:1`,
      productId: product.id, quantity: 20, tankId: "tank-doc-4",
      tankNumber: "4", batchNumber: "1733", date: "2026-11-09" },
    { id: `weekly-pack:2026-11-08:brew:${brewId}:ipa-crates:finish`,
      productId: product.id, quantity: 20, tankId: "tank-doc-4",
      tankNumber: "4", batchNumber: "1733", date: "2026-11-09" },
  ] };
  const aligned = withStablePackagingIdentity([week, original]);
  for (const run of aligned[1].packaging) {
    assert.equal(resolvePackagingBrewId(run, aligned), brewId);
    assert.equal(run.brewId, brewId);
    assert.equal(run.tankId, "tank-doc-4");
    assert.equal(run.tankNumber, "4", "never substitute Firestore id for physical number");
  }
});

test("future canonical batch uses saved net volume, not tank/style nominal", () => {
  const brewWeek = { ...emptyWeek(currentWeek), brews: [{
    id: "small-ipa", tankId: "tank-5", date: "2026-10-19",
    style: "IPA", liters: 1350, batchNumber: "1720",
  }] };
  const cycles = futureTanks([], [brewWeek], { ...defaultSettings(), products: [product] });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].liters, 1350, "custom smaller brew must not invent another 610 L");
});

test("brew recommendations skip already over-target styles", () => {
  const highCover = { ...product, monthly: 100, tempo: 100000 };
  const model = buildWeeklyPlanningModel({
    settings: { ...defaultSettings(), products: [highCover] }, pallets: [], tanks: [],
    plans: [], actuals: [], today, week: "2026-10-25", holidays: [], shipments: [],
    sources: [
      { id: "tank-5", tankNumber: 5, action: 4 },
      { id: "tank-6", tankNumber: 6, action: 4 },
    ],
  });
  assert.equal(model.brewRecommendations.length, 0);
});

test("large shortage can recommend multiple brews of the same style", () => {
  const model = buildWeeklyPlanningModel({
    settings: { ...defaultSettings(), products: [product] }, pallets: [], tanks: [],
    plans: [], actuals: [], today, week: "2026-10-25", holidays: [], shipments: [],
    sources: [
      { id: "tank-5", tankNumber: 5, action: 4 },
      { id: "tank-6", tankNumber: 6, action: 4 },
    ],
  });
  assert.equal(model.brewRecommendations.length, 2);
  assert.ok(model.brewRecommendations.every((brew) => brew.style === "IPA"));
  assert.notEqual(model.brewRecommendations[0].tankId, model.brewRecommendations[1].tankId);
});

test("a live canonical batch must receive its finishing pack despite over-target stock", () => {
  const pale: Product = { ...product, id: "pale-crates", sku: "pale-crates",
    style: "פייל אייל", monthly: 50, tempo: 20000 };
  const tank: Tank = { id: "tank-14", number: "14", batch: "live-14",
    style: pale.style, brewed: "2026-10-01", ready: "2026-10-22",
    liters: 3200, cold: true };
  const brewWeek = { ...emptyWeek("2026-09-27"), brews: [{
    id: "live-pale-14", tankId: "tank-14", date: "2026-10-01",
    style: pale.style, batchNumber: "live-14", liters: 3200,
  }] };
  const previous = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "partial-pale", brewId: "live-pale-14", productId: pale.id,
    quantity: 252, tankId: tank.id, tankNumber: "14",
    batchNumber: "live-14", date: "2026-11-05",
  }] };
  const model = buildWeeklyPlanningModel({
    settings: { ...defaultSettings(), products: [pale] }, pallets: [],
    tanks: [tank], plans: [brewWeek, previous], actuals: [],
    sources: [{ id: tank.id, tankNumber: 14, batchNumber: tank.batch,
      brewDate: "01/10/2026", beerStyle: tank.style, action: 1 }],
    today, week: "2026-11-08", holidays: [], shipments: [],
  });
  const finish = model.packagingRecommendation.filter((run) => run.tankNumber === "14");
  assert.equal(finish.length, 1, "do not abandon unfinished physical canonical cycles");
  assert.equal(finish[0].quantity, 152);
});
