import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  productionScopeForBrewAssignments, validateProduction,
} from "../src/SERVICES/planning/productionCycle";

const today = "2026-11-01";
const pale: Product = {
  id: "pale-kegs", sku: "pale", style: "פייל", type: "kegs",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [pale] };
const tank14: Tank = {
  id: "tank-14", number: "14", style: "פייל", batch: "1602",
  brewed: "2026-10-01", ready: "2026-10-22", liters: 2000, cold: true,
};
const edited: WeekPlan = {
  ...emptyWeek("2026-11-15"), brews: [{
    id: "brew-1620", tankId: "tank-14", style: "פייל",
    date: "2026-11-16", batchNumber: "1620", liters: 3200,
  }],
};
const unrelated: WeekPlan = {
  ...emptyWeek("2026-11-29"), packaging: [{
    id: "legacy-future-1615", productId: pale.id, quantity: 40,
    date: "2026-11-30", tankId: "tank-9", tankNumber: "9",
    batchNumber: "1615",
  }],
};

test("unrelated legacy tank 9 packaging cannot block confirming tank 14 brews", () => {
  const all = [edited, unrelated];
  assert.match(validateProduction(all, settings, [tank14], [], today) ?? "",
    /חסר מיכל מקור לאריזה.*מיכל 9.*1615/);
  const scoped = productionScopeForBrewAssignments(all, new Set(["tank-14"]));
  assert.equal(scoped[1].packaging.length, 0);
  assert.equal(scoped[0].brews.length, 1, "all canonical brews remain available");
  assert.equal(validateProduction(scoped, settings, [tank14], [], today), null);
  assert.equal(all[1].packaging.length, 1, "the persisted original plan is unchanged");
});

test("future packaging on the edited tank remains subject to validation", () => {
  const sameTank = {
    ...unrelated,
    packaging: [{ ...unrelated.packaging[0], tankId: "tank-14", tankNumber: "14" }],
  };
  const scoped = productionScopeForBrewAssignments([edited, sameTank], new Set(["tank-14"]));
  assert.equal(scoped[1].packaging.length, 1);
  assert.ok(validateProduction(scoped, settings, [tank14], [], today),
    "a future bad packaging decision on the same edited tank still blocks saving");
});

test("changing both tank assignments validates downstream packaging on both tanks", () => {
  const scoped = productionScopeForBrewAssignments(
    [edited, unrelated], new Set(["tank-14", "tank-9"]),
  );
  assert.equal(scoped[1].packaging.length, 1);
});
