import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  dailyForecast, futureTanks, tankCycleCanSupplyOn,
} from "../src/SERVICES/planning/dailyPlanner";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";

const today = "2026-10-29";
const product: Product = {
  id: "ipa-crates", style: "IPA", sku: "IPA", type: "crates",
  monthly: 294, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = {
  ...defaultSettings(),
  products: [product], preferredRuns: 5,
  targetWeeks: 5, totalTargetWeeks: 8.5,
};
const old: Tank = {
  id: "tank-11", number: "11", batch: "1590", style: "IPA",
  brewed: "2026-10-01", ready: "2026-10-22", liters: 48, cold: true,
};
const replacement = {
  id: "brew-ipa-11-week46", style: "IPA", tankId: "tank-11",
  batchNumber: "1615", date: "2026-11-09", liters: 3000,
  tankAssignmentStatus: "confirmed" as const,
};
const week46: WeekPlan = { ...emptyWeek("2026-11-08"), brews: [replacement] };
const source = { id: old.id, tankNumber: 11, batchNumber: old.batch,
  beerStyle: old.style, brewDate: "01/10/2026", action: 1 };
const modelFor = (week: string, plans: WeekPlan[] = [week46], tanks: Tank[] = [old]) =>
  buildWeeklyPlanningModel({
    settings, tanks, plans, pallets: [], actuals: [], sources: [source],
    today, week, holidays: [], shipments: [],
  });

test("week 45 may recommend draining 6 old IPA crates BEFORE tank 11's next brew", () => {
  const model = modelFor("2026-11-01");
  const finish = model.packagingRecommendation.find((run) =>
    run.tankId === old.id && run.productId === product.id);
  assert.ok(finish, "old 48 L cycle is still packable in week 45");
  assert.equal(finish.quantity, 6);
  assert.equal(tankCycleCanSupplyOn(old, [week46], "2026-11-05"), true);
  assert.equal(tankCycleCanSupplyOn(old, [week46], "2026-11-09"), false,
    "old batch ends the instant a different brew starts");
});

test("week 47 must NOT recommend tank 11's old 48 L cycle after week 46 rebrew", () => {
  const model = modelFor("2026-11-15");
  assert.equal(model.packagingRecommendation.filter((run) => run.tankId === old.id).length, 0,
    "future-week recommendation must not propose 6 crates from the previous IPA batch");
  assert.equal(model.tankAvailableLiters.get(old.id), 0,
    "the manual week-47 packaging editor must not offer old-batch volume either");
  const virtual = futureTanks([old], [week46], settings).find((tank) =>
    tank.id === `planned:${replacement.id}`);
  assert.ok(virtual, "retain the newly planned cycle alongside physical history");
  assert.equal(virtual.ready, "2026-11-30");
  assert.equal(model.packagingRecommendation.some((run) =>
    run.brewId === replacement.id), false,
    "new IPA also cannot be recommended during week 47, before its maturity date");
});

test("week 49 can recommend packaging the NEW batch, never its old physical predecessor", () => {
  const model = modelFor("2026-11-29");
  assert.ok(model.packagingRecommendation.some((run) =>
    run.brewId === replacement.id && run.tankId === old.id && run.quantity > 0),
    "new IPA appears after Nov 30 maturity with a stable brewId");
  assert.equal(model.packagingRecommendation.some((run) =>
    !run.brewId && run.tankId === old.id), false,
    "no six-crate carryover from the old batch after the new batch matures");
  assert.equal(model.tankAvailableLiters.get(old.id), 0);
  assert.equal(model.tankAvailableLiters.get(`planned:${replacement.id}`), 3000);
});

test("saved packaging cannot fabricate old finished stock after tank is rebrewed", () => {
  const oldLate: WeekPlan = {
    ...emptyWeek("2026-11-15"),
    packaging: [{
      id: "old-six-crates", productId: product.id, quantity: 6,
      date: "2026-11-16", tankId: old.id, tankNumber: old.number,
      batchNumber: old.batch,
    }],
  };
  const forecast = dailyForecast(
    settings, [], [old], [week46, oldLate], [], today,
  );
  const nov16 = forecast.points.find((point) =>
    point.date === "2026-11-16" && point.productId === product.id);
  assert.equal(nov16?.packed, 0,
    "a scheduled late old-batch run cannot create fictitious bottled inventory");
  assert.ok(forecast.warnings.some((warning) =>
    warning.includes("16/11/2026") && warning.includes("חסרים")),
    "the late commitment must report its missing physical volume, not vanish silently");

  const newCommitted: WeekPlan = {
    ...emptyWeek("2026-11-29"),
    packaging: [{
      id: "new-one-hundred-crates", productId: product.id, quantity: 100,
      date: "2026-12-02", tankId: old.id, tankNumber: old.number,
      batchNumber: replacement.batchNumber, brewId: replacement.id,
    }],
  };
  const good = dailyForecast(settings, [], [old], [week46, newCommitted], [], today);
  const dec2 = good.points.find((point) =>
    point.date === "2026-12-02" && point.productId === product.id);
  assert.equal(dec2?.packed, 100,
    "forecast must still package the later canonical batch once it is ready");
});

test("matching physical batch must not be rejected merely because planned brew date drifted", () => {
  const actualNew = {
    ...old, batch: replacement.batchNumber,
    brewed: "2026-11-10", ready: "2026-12-01", liters: 3000,
  };
  assert.equal(tankCycleCanSupplyOn(actualNew, [week46], "2026-12-02"), true,
    "this is the same physical batch as the Nov 9 plan, despite a one-day delay");
  assert.equal(futureTanks([actualNew], [week46], settings).length, 1,
    "no duplicate virtual tank for an already existing batch");
});

test("undated week-47 commitment to NEW IPA batch cannot be credited before maturation", () => {
  const week47: WeekPlan = {
    ...emptyWeek("2026-11-15"),
    packaging: [{
      id: "week47-future-new-batch", productId: product.id, quantity: 100,
      tankId: old.id, tankNumber: old.number,
      brewId: replacement.id, batchNumber: replacement.batchNumber,
    }],
  };
  const model = modelFor("2026-11-15", [week46, week47]);
  const before = model.rows.afterShipment.get(product.id);
  const after = model.rows.afterPackaging.get(product.id);
  assert.ok(before && after);
  assert.equal(after.breweryUnits, before.breweryUnits,
    "the next brew's 100 crates cannot appear in the week-47 stock forecast");
  assert.equal(after.totalCover, before.totalCover,
    "week-47 stock coverage must not include beer still fermenting");

  const future = model.forecasts.afterPackaging.points;
  assert.equal(future.find((p) => p.date === "2026-11-19" && p.productId === product.id)?.packed, 0,
    "the default undated row's Thursday date is NOT permission to bypass maturation");
  assert.equal(future.find((p) => p.date === "2026-11-30" && p.productId === product.id)?.packed, 100,
    "forecast the undated new-batch commitment on Nov 30 when the batch matures");
});
