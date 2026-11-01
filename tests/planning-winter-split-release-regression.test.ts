import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  forecastUndatedTankReleasePackaging, tankReleases, validateBrewReleases,
  type TankSource,
} from "../src/SERVICES/planning/productionCycle";
import { validatePlanningDecisionChange } from "../src/SERVICES/planning/planningDecisionSafety";

const today = "2026-11-01";
const winterCrates: Product = {
  id: "winter-crates", sku: "7009876", style: "חורף", type: "crates",
  monthly: 0, tempo: 0, tempoDate: today, leadDays: 21,
};
const lagerKegs: Product = {
  id: "lager-kegs", sku: "7009942", style: "לאגר", type: "kegs",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [winterCrates, lagerKegs] };
const tank: Tank = {
  id: "tank-6", number: "6", style: "חורף", batch: "1600",
  brewed: "2026-09-29", ready: "2026-10-20", liters: 1620, cold: true,
};
const source: TankSource = {
  id: tank.id, tankNumber: 6, batchNumber: "1600",
  brewDate: "29/09/2026", beerStyle: "חורף",
  beerVolume: 1800, action: 1, tankStatus: false,
};
const next: WeekPlan = {
  ...emptyWeek("2026-11-08"), brews: [{
    id: "lager-tank-6-nov9", tankId: tank.id,
    style: "לאגר", date: "2026-11-09", liters: 2500, batchNumber: "1615",
  }],
};
const oldWeek: WeekPlan = {
  ...emptyWeek("2026-11-01"), packaging: [{
    id: "winter-204-crates", productId: winterCrates.id, quantity: 204,
    tankId: tank.id, tankNumber: tank.number, batchNumber: "1600",
    emptyTank: true,
  }],
};
const splitWeek: WeekPlan = {
  ...emptyWeek("2026-11-01"), packaging: [
    {
      id: "winter-20-kegs", productId: "", quantity: 20,
      nonInventoryStyle: "חורף", nonInventoryType: "kegs",
      tankId: tank.id, tankNumber: tank.number, batchNumber: "1600",
      emptyTank: false,
    },
    {
      id: "winter-154-crates", productId: winterCrates.id, quantity: 154,
      tankId: tank.id, tankNumber: tank.number, batchNumber: "1600",
      emptyTank: true,
    },
  ],
};

test("tank 6: undated 20 winter kegs + 154 winter crates release next Monday's lager brew", () => {
  const decisions = [splitWeek, next];
  assert.equal(splitWeek.packaging.every((run) => !run.date), true);
  const projected = forecastUndatedTankReleasePackaging(decisions, [tank], settings);
  assert.deepEqual(projected[0].packaging.map((run) => run.date),
    ["2026-11-05", "2026-11-05"]);
  assert.equal(splitWeek.packaging.every((run) => !run.date), true,
    "daily packaging dates must not be persisted just to approve a weekly decision");
  const release = tankReleases([source], [tank], decisions, settings, [], today)[0];
  assert.equal(release.emptyDate, "2026-11-05");
  assert.equal(release.date, "2026-11-09");
  assert.equal(validateBrewReleases([source], [tank], decisions, settings, [], today), null);
});

test("weekly winter-format split may be saved without unrelated next-week lager release error", () => {
  const before = [oldWeek, next];
  const after = [splitWeek, next];
  assert.equal(validatePlanningDecisionChange({
    before, after, edited: splitWeek, previous: oldWeek,
    settings, tanks: [tank], sources: [source], actuals: [], today,
  }), null);
});

test("split decision with existing Monday crates and undated new Thursday kegs is still a complete drain", () => {
  const split = {
    ...splitWeek, packaging: [
      { ...splitWeek.packaging[0], emptyTank: true },
      { ...splitWeek.packaging[1], date: "2026-11-02", emptyTank: false },
    ],
  };
  const releases = tankReleases([source], [tank], [split, next], settings, [], today);
  assert.equal(releases[0].date, "2026-11-09");
  assert.equal(releases[0].emptyDate, "2026-11-05");
});

test("a partial weekly packaging commitment must not release the tank", () => {
  const partial = {
    ...splitWeek,
    packaging: splitWeek.packaging.map((run) => ({
      ...run,
      quantity: run.nonInventoryType ? 10 : 100,
      emptyTank: false,
    })),
  };
  const release = tankReleases([source], [tank], [partial, next], settings, [], today)[0];
  assert.equal(release.date, null);
  assert.match(validateBrewReleases([source], [tank], [partial, next], settings, [], today) ?? "",
    /מיכל 6/);
});

test("a tank not mature by the forecast packaging day must not be freed", () => {
  const youngTank = { ...tank, ready: "2026-11-10" };
  const plans = [splitWeek, next];
  const projected = forecastUndatedTankReleasePackaging(plans, [youngTank], settings);
  assert.equal(projected[0].packaging.every((run) => !run.date), true);
  const release = tankReleases([source], [youngTank], plans, settings, [], today)[0];
  assert.equal(release.date, null);
});

test("undated winter packaging next week cannot free tank 6 for a Nov 9 brew", () => {
  const delayed = { ...splitWeek, id: "2026-11-08" };
  const release = tankReleases([source], [tank], [delayed, next], settings, [], today)[0];
  assert.equal(release.date, "2026-11-16");
  assert.match(validateBrewReleases([source], [tank], [delayed, next], settings, [], today) ?? "",
    /מיכל 6/);
});
