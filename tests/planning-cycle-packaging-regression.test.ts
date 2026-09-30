import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { resolvePackagingBrewId } from "../src/SERVICES/planning/planIdentity";

const product: Product = {
  id: "ipa-crates",
  sku: "ipa-crates",
  style: "IPA",
  type: "crates",
  monthly: 294,
  tempo: 0,
  tempoDate: "2026-09-30",
  leadDays: 21,
};

const settings = {
  ...defaultSettings(),
  products: [product],
  preferredRuns: 5,
  targetWeeks: 5,
  totalTargetWeeks: 8.5,
};

test("weekly packaging recommendation can target a committed future brew cycle", () => {
  const brewId = "brew-future-ipa-10";
  const brewWeek = {
    ...emptyWeek("2026-09-13"),
    brews: [{
      id: brewId,
      style: "IPA",
      tankId: "tank-10",
      date: "2026-09-14",
      liters: 4000,
      batchNumber: "1677",
      tankAssignmentStatus: "confirmed" as const,
    }],
  };

  const model = buildWeeklyPlanningModel({
    settings,
    pallets: [],
    tanks: [],
    plans: [brewWeek],
    actuals: [],
    sources: [{ id: "tank-10", tankNumber: 10, tankStatus: true, beerVolume: 4000 }],
    today: "2026-09-30",
    week: "2026-10-04",
    holidays: [],
    shipments: [],
  });

  const recommendation = model.packagingRecommendation.find((run) => run.brewId === brewId);
  assert.ok(recommendation, "future committed cycle should be eligible for packaging");
  assert.equal(recommendation.tankId, "tank-10");
  assert.equal(recommendation.tankNumber, "10");
  assert.match(recommendation.id, /:brew:brew-future-ipa-10:/);
});

test("canonical recommendation id survives legacy save paths and resolves back to brewId", () => {
  const brewId = "brew-future-ipa-10";
  const plans = [{
    ...emptyWeek("2026-09-13"),
    brews: [{ id: brewId, style: "IPA", tankId: "tank-10", date: "2026-09-14", liters: 4000 }],
  }];

  const resolved = resolvePackagingBrewId({
    id: `weekly-pack:2026-10-04:brew:${brewId}:ipa-crates`,
    productId: product.id,
    quantity: 168,
    tankId: "tank-10",
  }, plans);

  assert.equal(resolved, brewId);
});


test("Gantt decision projection must preserve canonical brewId", () => {
  const brewId = "brew-future-ipa-10";
  const recommendation = {
    id: `weekly-pack:2026-10-04:brew:${brewId}:ipa-crates`,
    productId: product.id,
    quantity: 168,
    tankId: "tank-10",
    tankNumber: "10",
    brewId,
  };
  const saved = {
    id: recommendation.id,
    productId: recommendation.productId,
    quantity: recommendation.quantity,
    tankId: recommendation.tankId,
    tankNumber: recommendation.tankNumber,
    ...(recommendation.brewId ? { brewId: recommendation.brewId } : {}),
    source: "recommendation" as const,
  };
  assert.equal(saved.brewId, brewId);
});


test("stale explicit brewId is not treated as canonical identity", () => {
  const plans = [{
    ...emptyWeek("2026-09-27"),
    brews: [{ id: "brew-real-1571", style: "IPA", tankId: "tank-8", date: "2026-09-01", liters: 3000, batchNumber: "1571" }],
  }];
  const resolved = resolvePackagingBrewId({
    id: "legacy-packaging-row",
    productId: product.id,
    quantity: 100,
    tankId: "tank-8",
    tankNumber: "8",
    batchNumber: "1601",
    brewId: "deleted-or-stale-brew",
    date: "2026-10-01",
  }, plans);
  assert.equal(resolved, null);
});


test("legacy packaging without batch never binds to a future brew by tank alone", () => {
  const plans = [{
    ...emptyWeek("2026-10-04"),
    brews: [{ id: "future-cycle-tank-8", style: "IPA", tankId: "tank-8", date: "2026-10-05", liters: 3000, batchNumber: "1601" }],
  }];
  assert.equal(resolvePackagingBrewId({
    id: "physical-tank-8-packaging",
    productId: product.id,
    quantity: 100,
    tankId: "tank-8",
    tankNumber: "8",
    date: "2026-10-20",
  }, plans), null);
});
