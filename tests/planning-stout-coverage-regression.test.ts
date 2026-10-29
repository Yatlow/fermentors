import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, weeklyDemand,
  type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import { futureTanks } from "../src/SERVICES/planning/dailyPlanner";
import {
  buildWeeklyPlanningModel, forecastPackagingUnits, plannedPackagingCover,
} from "../src/SERVICES/planning/weeklyPlanningModel";
import { validateProduction } from "../src/SERVICES/planning/productionCycle";

const today = "2026-10-29";
const week = "2026-11-08";
const stout: Product = {
  id: "stout-crates", sku: "stout-crates", style: "סטאוט",
  type: "crates", monthly: 80, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = {
  ...defaultSettings(), products: [stout], preferredRuns: 5,
  targetWeeks: 5, totalTargetWeeks: 8.5,
};
const tank: Tank = {
  id: "tank-3", number: "3", batch: "1610", style: stout.style,
  brewed: "2026-10-01", ready: "2026-10-22", liters: 1093, cold: true,
};
const source = {
  id: tank.id, tankNumber: 3, beerStyle: stout.style,
  batchNumber: tank.batch, brewDate: "01/10/2026", action: 1,
};
const modelFor = (tanks: Tank[], plans: WeekPlan[], sources = [source]) =>
  buildWeeklyPlanningModel({
    settings, pallets: [], tanks, plans, actuals: [], sources,
    today, week, holidays: [], shipments: [],
  });

test("138 stout crates in tank 3 are valid when its physical balance is 1093 L", () => {
  const original = modelFor([tank], []);
  const recommended = original.packagingRecommendation.find((p) => p.tankNumber === "3");
  assert.equal(recommended?.quantity, 138);
  const decided: WeekPlan = {
    ...emptyWeek(week), packaging: [{
      id: "stout-week46", productId: stout.id, tankId: tank.id,
      tankNumber: tank.number, batchNumber: tank.batch,
      date: "2026-11-09", quantity: 138,
    }],
  };
  const result = modelFor([tank], [decided]);
  const before = result.rows.afterShipment.get(stout.id);
  const after = result.rows.afterPackaging.get(stout.id);
  const recCover = plannedPackagingCover(before, recommended!.quantity);
  const decisionCover = plannedPackagingCover(before, decided.packaging[0].quantity);
  assert.equal(recCover, decisionCover, "equal recommendation/decision units must show equal coverage");
  assert.ok(recCover !== null && recCover > 0);
  assert.ok(Math.abs((forecastPackagingUnits(before, after) ?? 0) - 138) < 0.01,
    "operational forecast can allocate the full 138 crates from the same physical batch");
  assert.equal(validateProduction([decided], settings, [tank], [], today), null,
    "the weekly engine must not recommend an unschedulable 138-crate stout shift");
});

test("a later reservation on the same stout batch reduces week-46 recommendations", () => {
  const reserved: WeekPlan = {
    ...emptyWeek("2026-11-15"), packaging: [{
      id: "stout-reserved-week47", productId: stout.id,
      tankId: tank.id, tankNumber: "3", batchNumber: tank.batch,
      date: "2026-11-16", quantity: 84,
    }],
  };
  const model = modelFor([tank], [reserved]);
  const recommended = model.packagingRecommendation
    .filter((run) => run.tankId === tank.id && run.productId === stout.id)
    .reduce((n, run) => n + run.quantity, 0);
  assert.ok(recommended <= 54,
    "week-46 recommendation cannot consume stout already reserved for week 47");
  assert.ok(recommended > 0, "the unreserved part can still be recommended");
});

test("a physical batch and its future replacement must have independent balances", () => {
  const futureBrew = {
    id: "future-stout-3", tankId: tank.id, style: stout.style,
    date: "2026-10-12", liters: 1100, batchNumber: "1701",
  };
  const brewWeek: WeekPlan = {
    ...emptyWeek("2026-10-11"), brews: [futureBrew],
  };
  const decided: WeekPlan = {
    ...emptyWeek(week), packaging: [{
      id: "weekly-pack:2026-11-08:brew:future-stout-3:stout-crates",
      productId: stout.id, quantity: 138, tankId: tank.id,
      tankNumber: "3", batchNumber: "1701", brewId: futureBrew.id,
      date: "2026-11-09",
    }],
  };
  const oldCycle: Tank = {
    ...tank, brewed: "2026-09-01", batch: "1600", liters: 0,
  };
  const plans = [brewWeek, decided];
  assert.equal(validateProduction(plans, settings, futureTanks([oldCycle], plans, settings), [], today), null,
    "a depleted old batch must not block valid packaging of a distinct future brew");
  const model = modelFor([oldCycle], plans);
  const actualAllocated = forecastPackagingUnits(
    model.rows.afterShipment.get(stout.id),
    model.rows.afterPackaging.get(stout.id),
  );
  assert.ok(actualAllocated !== null && Math.abs(actualAllocated - 138) < 0.01,
    "decision forecast uses the future cycle volume, not the depleted physical tank");
});

test("an already-physical brew without batch metadata uses the real remaining volume", () => {
  const recordedBrew: WeekPlan = {
    ...emptyWeek("2026-09-27"), brews: [{
      id: "current-stout", style: stout.style, tankId: tank.id,
      date: tank.brewed, liters: 1100,
    }],
  };
  const planned: WeekPlan = {
    ...emptyWeek(week), packaging: [{
      id: "overstated-stout", productId: stout.id, tankId: tank.id,
      tankNumber: "3", brewId: "current-stout", batchNumber: tank.batch,
      quantity: 138, date: "2026-11-09",
    }],
  };
  const smallerPhysical = { ...tank, liters: 1050 };
  const message = validateProduction([recordedBrew, planned], settings, [smallerPhysical], [], today);
  assert.match(message ?? "", /הכמות המתוכננת גדולה מהנפח הזמין/);
  assert.match(message ?? "", /1093\.0 ל׳ מתוכננים מול 1050\.0 ל׳ זמינים/);
  assert.match(message ?? "", /עד 132 ארגזים/,
    "show a feasible quantity and the exact liters instead of an opaque block");
});

test("coverage helpers distinguish planned quantity from physically allocatable units", () => {
  const state = {
    product: stout, tempoUnits: 0, breweryUnits: 0,
    tempoCover: 0, totalCover: 0,
  };
  const planned = plannedPackagingCover(state, 138);
  const allocated = forecastPackagingUnits(state, {
    ...state, totalCover: 8 / weeklyDemand(stout),
  });
  assert.equal(planned, 138 / weeklyDemand(stout));
  assert.equal(allocated, 8);
  assert.equal(plannedPackagingCover(state, 138), planned,
    "recommendation and decision calculations are source-independent");
});
