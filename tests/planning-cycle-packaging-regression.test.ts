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
