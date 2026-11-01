import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  futureTanks, physicalTankMatchesBrew, tankCycleCanSupplyOn,
} from "../src/SERVICES/planning/dailyPlanner";
import {
  assignableTankReleasesForWeek, tankReleases, validateBrewReleases,
  type TankSource,
} from "../src/SERVICES/planning/productionCycle";
import { projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";

const today = "2026-11-01";
const hoppyKegs: Product = {
  id: "hoppy-kegs", sku: "7013781", style: "הופי לאגר", type: "kegs",
  monthly: 250, tempo: 0, tempoDate: today, leadDays: 21,
};
const paleKegs: Product = {
  id: "pale-kegs", sku: "7009939", style: "פייל", type: "kegs",
  monthly: 200, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [hoppyKegs, paleKegs], preferredRuns: 5 };
const physicalHoppy: Tank = {
  id: "tank-19", number: "19", style: "הופי לאגר", batch: "1601",
  brewed: "2026-10-05", ready: "2026-10-26", liters: 3571.2, cold: true,
};
const hoppySource: TankSource = {
  id: "tank-19", tankNumber: 19, batchNumber: "1601", brewDate: "05/10/2026",
  beerStyle: "הופי לאגר", beerVolume: 3968, action: 1, tankStatus: false,
  stage: { className: "stage-cold" },
};

test("tank 19 stays an eligible physical Hoppy Lager source when an old forecast batch number drifted", () => {
  const oldForecastBrew = {
    id: "forecast-old-1600", tankId: physicalHoppy.id, style: "הופי לאגר",
    batchNumber: "1600", date: "2026-10-05", liters: 3600,
  };
  const plans: WeekPlan[] = [{
    ...emptyWeek("2026-10-04"), brews: [oldForecastBrew],
  }];
  assert.equal(physicalTankMatchesBrew(physicalHoppy, oldForecastBrew), true);
  assert.equal(futureTanks([physicalHoppy], plans, settings).length, 1,
    "a stale forecast number must not create a second imaginary physical batch");
  assert.equal(tankCycleCanSupplyOn(physicalHoppy, plans, "2026-11-05"), true);

  const model = buildWeeklyPlanningModel({
    settings, pallets: [], tanks: [physicalHoppy], sources: [hoppySource],
    plans, actuals: [], today, week: "2026-11-01", holidays: [], shipments: [],
  });
  assert.ok((model.tankAvailableLiters.get(physicalHoppy.id) ?? 0) >= 20,
    "the packaging editor must not report no Hoppy Lager tank");
  assert.ok(model.packagingRecommendation.some((run) =>
    run.tankId === physicalHoppy.id && run.productId === hoppyKegs.id && run.quantity > 0),
    "the current physical Hoppy Lager batch is still eligible for a packaging recommendation");
});

test("a truly later physical-tank rebrew still supersedes the old Hoppy Lager cycle", () => {
  const newBrew = {
    id: "new-hoppy-cycle", tankId: physicalHoppy.id, style: "הופי לאגר",
    batchNumber: "1628", date: "2026-11-09", liters: 3600,
  };
  const plans: WeekPlan[] = [{ ...emptyWeek("2026-11-08"), brews: [newBrew] }];
  assert.equal(physicalTankMatchesBrew(physicalHoppy, newBrew), false);
  assert.equal(tankCycleCanSupplyOn(physicalHoppy, plans, "2026-11-05"), true);
  assert.equal(tankCycleCanSupplyOn(physicalHoppy, plans, "2026-11-16"), false);
  const model = buildWeeklyPlanningModel({
    settings, pallets: [], tanks: [physicalHoppy], sources: [hoppySource],
    plans, actuals: [], today, week: "2026-11-15", holidays: [], shipments: [],
  });
  assert.equal(model.tankAvailableLiters.get(physicalHoppy.id), 0,
    "a second real cycle must not permit repacking the old batch");
});

test("tank 14 is selectable after its exact physical Pale batch is planned to empty, despite stale canonical forecast number", () => {
  const physicalPale: Tank = {
    id: "tank-14", number: "14", style: "פייל", batch: "1602",
    brewed: "2026-09-30", ready: "2026-10-21", liters: 1920, cold: true,
  };
  const paleSource: TankSource = {
    id: physicalPale.id, tankNumber: 14, batchNumber: "1602",
    brewDate: "30/09/2026", beerStyle: "פייל", beerVolume: 2200,
    action: 1, tankStatus: false, stage: { className: "stage-cold" },
  };
  const original: WeekPlan = {
    ...emptyWeek("2026-09-27"), brews: [{
      id: "old-pale-forecast", tankId: physicalPale.id, style: "פייל",
      date: "2026-09-30", batchNumber: "1599", liters: 1920,
    }],
  };
  const emptying: WeekPlan = {
    ...emptyWeek("2026-11-08"), packaging: [{
      id: "empty-pale-1602", productId: paleKegs.id, quantity: 96,
      tankId: physicalPale.id, tankNumber: physicalPale.number,
      batchNumber: physicalPale.batch, date: "2026-11-12", emptyTank: true,
    }],
  };
  const nextWeek: WeekPlan = {
    ...emptyWeek("2026-11-15"), brews: [{
      id: "new-pale-1620", tankId: physicalPale.id, style: "פייל",
      date: "2026-11-16", batchNumber: "1620", liters: 3200,
    }],
  };
  const plans = [original, emptying, nextWeek];
  const releases = tankReleases([paleSource], [physicalPale], plans, settings, [], today);
  assert.equal(releases[0]?.emptyDate, "2026-11-12");
  assert.equal(releases[0]?.date, "2026-11-16");

  const schedules = projectTankSchedules(plans, settings, today, [physicalPale]);
  assert.equal(schedules.get(physicalPale.id)?.[0]?.emptyDate, undefined,
    "legacy physical packaging is not directly linked to a stale forecast batch");
  const available = assignableTankReleasesForWeek(
    releases, schedules, [paleSource], [physicalPale], today, "2026-11-15",
    new Set(["new-pale-1620"]),
  );
  assert.deepEqual(available.map((release) => release.tankId), [physicalPale.id],
    "the assignment picker must see the same physical release as the save validator");
  assert.equal(validateBrewReleases(
    [paleSource], [physicalPale], plans, settings, [], today, "2026-11-15",
  ), null);
});

test("a partial packaging day cannot release tank 14, and a Thursday release cannot be used for a Monday-Wednesday brew", () => {
  const pale: Tank = {
    id: "tank-14", number: "14", style: "פייל", batch: "1602",
    brewed: "2026-09-30", ready: "2026-10-21", liters: 1920, cold: true,
  };
  const source: TankSource = {
    id: pale.id, tankNumber: 14, batchNumber: "1602",
    brewDate: "30/09/2026", beerStyle: "פייל", beerVolume: 2200,
    action: 1, tankStatus: false,
  };
  const half: WeekPlan = {
    ...emptyWeek("2026-11-08"), packaging: [{
      id: "half-pale", productId: paleKegs.id, quantity: 48,
      tankId: pale.id, tankNumber: pale.number, batchNumber: pale.batch,
      date: "2026-11-12", emptyTank: false,
    }],
  };
  const releases = tankReleases([source], [pale], [half], settings, [], today);
  assert.equal(releases[0]?.date, null);
  assert.equal(assignableTankReleasesForWeek(
    releases, projectTankSchedules([half], settings, today, [pale]),
    [source], [pale], today, "2026-11-15",
  ).length, 0);

  const freedOnThursday = [{
    ...releases[0], date: "2026-11-19", emptyDate: "2026-11-18",
  }];
  assert.equal(assignableTankReleasesForWeek(
    freedOnThursday, new Map(), [source], [pale], today, "2026-11-15",
  ).length, 0);
});
