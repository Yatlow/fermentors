import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings,
  emptyWeek,
  type Product,
  type Tank,
} from "../src/SERVICES/planning/planningEngine";
import {
  planningTargetsForStyle,
  withStylePlanningTarget,
} from "../src/SERVICES/planning/planningTargets";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { matchActualShipments } from "../src/SERVICES/planning/shipmentActuals";

const today = "2026-09-13";

function product(id: string, type: "crates" | "kegs"): Product {
  return {
    id,
    sku: id,
    style: "IPA",
    type,
    monthly: 420,
    tempo: 0,
    tempoDate: today,
    leadDays: 21,
  };
}

test("coverage targets can be overridden independently for each style", () => {
  const base = defaultSettings();
  const next = withStylePlanningTarget(base, "IPA", {
    targetWeeks: 4,
    totalTargetWeeks: 6,
    maxTotalWeeks: 8,
  });

  assert.deepEqual(planningTargetsForStyle(next, "IPA"), {
    targetWeeks: 4,
    totalTargetWeeks: 6,
    maxTotalWeeks: 8,
  });
  assert.equal(planningTargetsForStyle(next, "חיטה").totalTargetWeeks, base.totalTargetWeeks);
});

test("weekly packaging can split one FIFO tank between crates and kegs without crossing max coverage", () => {
  const crates = product("ipa-crates", "crates");
  const kegs = product("ipa-kegs", "kegs");
  let settings = {
    ...defaultSettings(),
    preferredRuns: 5,
    products: [crates, kegs],
  };
  settings = withStylePlanningTarget(settings, "IPA", {
    targetWeeks: 1,
    totalTargetWeeks: 1,
    maxTotalWeeks: 2,
  });

  const tank: Tank = {
    id: "tank-old",
    number: "9",
    batch: "100",
    style: "IPA",
    brewed: "2026-08-01",
    ready: today,
    liters: 3000,
    cold: true,
  };

  const model = buildWeeklyPlanningModel({
    settings,
    pallets: [],
    tanks: [tank],
    plans: [emptyWeek(today)],
    actuals: [],
    sources: [{ id: tank.id, tankNumber: 9, beerStyle: "IPA", beerVolume: 3000 }],
    today,
    week: today,
    holidays: [],
    shipments: [],
  });

  const fromTank = model.packagingRecommendation.filter((rec) => rec.tankId === tank.id);
  assert.equal(new Set(fromTank.map((rec) => rec.productId)).size, 2);
  assert.ok(fromTank.every((rec) => rec.fifoRank === 1 && rec.sizeLabel === "משולש"));

  for (const rec of fromTank) {
    const p = rec.productId === crates.id ? crates : kegs;
    const weeksAdded = rec.quantity / (p.monthly / 4.2);
    assert.ok(weeksAdded <= 2 + 1e-9);
  }
});

test("two actual shipments in the same week are matched to two planned trips independently", () => {
  const crates = product("ipa-crates", "crates");
  const kegs = product("ipa-kegs", "kegs");
  const deliveries = [
    { id: "d1", productId: crates.id, quantity: 84, dispatchDate: "2026-09-14", arrivalDate: "2026-09-14", truckId: "truck-a" },
    { id: "d2", productId: kegs.id, quantity: 40, dispatchDate: "2026-09-17", arrivalDate: "2026-09-17", truckId: "truck-b" },
  ];
  const actuals = [
    { id: "s1", date: "2026-09-14", totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 84 }] },
    { id: "s2", date: "2026-09-17", totals: [{ itemType: "kegs" as const, beerStyle: "IPA", totalQuantity: 40 }] },
  ];

  const matches = matchActualShipments(deliveries, actuals, [crates, kegs]);
  assert.equal(matches.length, 2);
  assert.ok(matches.every((match) => match.status === "matched"));
  assert.deepEqual(matches.map((match) => match.actual?.id).sort(), ["s1", "s2"]);
});

test("a shipment below 85 percent SKU overlap is flagged as actual-different", () => {
  const crates = product("ipa-crates", "crates");
  const deliveries = [
    { id: "d1", productId: crates.id, quantity: 100, dispatchDate: "2026-09-14", arrivalDate: "2026-09-14", truckId: "truck-a" },
  ];
  const actuals = [
    { id: "s1", date: "2026-09-14", totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 70 }] },
  ];

  const [match] = matchActualShipments(deliveries, actuals, [crates]);
  assert.equal(match.status, "actual-different");
  assert.equal(match.score, 0.7);
});
