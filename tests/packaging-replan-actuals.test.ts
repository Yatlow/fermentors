import assert from "node:assert/strict";
import test from "node:test";
import { tankReleases, validateProduction, validateBrewReleases } from "../src/SERVICES/planning/productionCycle";
import { openRuns } from "../src/SERVICES/planning/dailyPlanner";
import { mergeCompletedPackagingBack } from "../src/SERVICES/planning/packagingActuals";
import type { Settings, WeekPlan, Actual } from "../src/SERVICES/planning/planningEngine";

const products: Settings["products"] = [
  { id: "pils-kegs", style: "Pils", type: "kegs", sku: "PK", monthly: 0, tempo: 0, tempoDate: "", leadDays: 21 },
  { id: "pils-crates", style: "Pils", type: "crates", sku: "PC", monthly: 0, tempo: 0, tempoDate: "", leadDays: 21 },
];
const week = (): WeekPlan => ({
  id: "2026-10-11", revision: 0, packaging: [], brews: [], note: "", maxRuns: 5,
});

test("retains executed kegs when replacing this week's packaging decisions", () => {
  const original = week();
  original.packaging = [{ id: "old", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" }];
  const edited = week();
  edited.packaging = [{ id: "new", productId: "pils-crates", quantity: 252, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-14", emptyTank: true }];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const merged = mergeCompletedPackagingBack(original, edited, products, actuals, []);
  assert.equal(merged.packaging.length, 2);
  assert.equal(merged.packaging[0].quantity, 70);
  assert.equal(merged.packaging[0].emptyTank, false);
  assert.equal(merged.packaging[1].quantity, 252);
  assert.equal(merged.packaging[1].emptyTank, true);
});

test("splits partially executed row without duplicating the executed quantity", () => {
  const original = week();
  original.packaging = [{ id: "old", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" }];
  const edited = week();
  edited.packaging = [{ ...original.packaging[0], quantity: 90, date: "2026-10-15" }];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const merged = mergeCompletedPackagingBack(original, edited, products, actuals, []);
  assert.deepEqual(merged.packaging.map((run) => run.quantity), [70, 20]);
  assert.equal(merged.packaging[0].date, "2026-10-12");
  assert.equal(merged.packaging[1].date, "2026-10-15");
  assert.notEqual(merged.packaging[0].id, merged.packaging[1].id);
});


test("re-saving a split plan keeps executed and pending quantities unchanged", () => {
  const original = week();
  original.packaging = [{ id: "old", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" }];
  const edited = week();
  edited.packaging = [{ ...original.packaging[0], quantity: 90, date: "2026-10-15" }];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const once = mergeCompletedPackagingBack(original, edited, products, actuals, []);
  const twice = mergeCompletedPackagingBack(once, once, products, actuals, []);
  assert.deepEqual(twice.packaging, once.packaging);
});


test("past actual cannot complete a rescheduled future row", () => {
  const plan = week();
  plan.packaging = [
    { id: "done", productId: "pils-kegs", quantity: 70, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" },
    { id: "later", productId: "pils-kegs", quantity: 20, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-15" },
  ];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const runs = openRuns([plan], products, actuals);
  assert.equal(runs.find((r) => r.id === "done")?.remaining, 0);
  assert.equal(runs.find((r) => r.id === "later")?.remaining, 20);
});


test("tank 15 releases for next brewing week after kegs Monday and crates Wednesday", () => {
  const plan = week();
  plan.packaging = [
    { id: "done", productId: "pils-kegs", quantity: 70, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" },
    { id: "finish", productId: "pils-crates", quantity: 252, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-14", emptyTank: true },
  ];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2000, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  const sources = [{ id: "tank15", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", action: 1 }];
  assert.equal(validateProduction([plan], settings, [tank], actuals, "2026-10-14"), null);
  const release = tankReleases(sources, [tank], [plan], settings, actuals, "2026-10-14")[0];
  assert.equal(release.emptyDate, "2026-10-14");
  assert.equal(release.date, "2026-10-19");
});


test("new actual on remaining row survives replanning", () => {
 const original = week();
 original.packaging = [{ id: "old", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" }];
 const first = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
 const edited = { ...week(), packaging: [{ ...original.packaging[0], quantity: 90, date: "2026-10-15" }] };
 const once = mergeCompletedPackagingBack(original, edited, products, first, []);
 const actuals = [...first, { id: "a2", date: "2026-10-15", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 10 }] as Actual[];
 const twice = mergeCompletedPackagingBack(once, once, products, actuals, []);
 assert.equal(twice.packaging.reduce((n, r) => n + r.quantity, 0), 90);
 assert.equal(openRuns([twice], products, actuals).reduce((n, r) => n + r.remaining, 0), 10);
});


test("legacy packaging tank number resolves to physical document id", () => {
 const plan = week();
 plan.packaging = [{ id: "legacy", productId: "pils-crates", quantity: 10, tankId: "15", tankNumber: "15", date: "2026-10-15" }];
 const tank = { id: "fermentor-15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2000, cold: true };
 const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
 assert.equal(validateProduction([plan], settings, [tank], [], "2026-10-14"), null);
});

test("next-week brew is allowed when current batch empties via numeric legacy tank id", () => {
  const plan = week();
  plan.packaging = [
    { id: "finish-15", productId: "pils-crates", quantity: 252, tankId: "15", tankNumber: "15", batchNumber: "1600", date: "2026-10-14", emptyTank: true },
  ];
  plan.brews = [{ id: "future-15", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000 }];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2000, cold: true };
  const source = { id: "tank15", tankNumber: "15", batchNumber: "1600", brewDate: "01/09/2026", beerStyle: "Pils", action: 1 };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  const release = tankReleases([source], [tank], [plan], settings, [], "2026-10-14")[0];
  assert.equal(release.emptyDate, "2026-10-14");
  assert.equal(release.date, "2026-10-19");
  assert.equal(validateBrewReleases([source], [tank], [plan], settings, [], "2026-10-14"), null);
});

test("next-week brew stays blocked if current batch has no planned emptying", () => {
  const plan = week();
  plan.brews = [{ id: "future-15", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000 }];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2000, cold: true };
  const source = { id: "tank15", tankNumber: "15", batchNumber: "1600", brewDate: "01/09/2026", beerStyle: "Pils", action: 1 };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(tankReleases([source], [tank], [plan], settings, [], "2026-10-14")[0].date, null);
  assert.match(validateBrewReleases([source], [tank], [plan], settings, [], "2026-10-14") ?? "", /תוכנית הריקון/);
});

test("early actual completes the same physical batch despite later planned date", () => {
  const plan = week();
  plan.packaging = [{ id: "late-10", productId: "pils-kegs", quantity: 156, tankId: "tank10", tankNumber: "10", batchNumber: "1601", date: "2026-10-15" }];
  const actuals = [{ id: "early-10", date: "2026-10-13", tankNumber: "10", batchNumber: "1601", beerStyle: "Pils", packagingType: "kegs", quantity: 159 }] as Actual[];
  assert.equal(openRuns([plan], products, actuals)[0].remaining, 0);
  const tank = { id: "tank10", number: "10", style: "Pils", batch: "1601", brewed: "2026-09-01", ready: "2026-10-01", liters: 100, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([plan], settings, [tank], actuals, "2026-10-14"), null);
});

test("early actual does not consume a different batch or an unidentified tank", () => {
  const plan = week();
  plan.packaging = [
    { id: "other-batch", productId: "pils-kegs", quantity: 20, tankId: "tank10", tankNumber: "10", batchNumber: "1602", date: "2026-10-15" },
    { id: "unidentified", productId: "pils-kegs", quantity: 20, date: "2026-10-15" },
  ];
  const actuals = [{ id: "early", date: "2026-10-13", tankNumber: "10", batchNumber: "1601", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const runs = openRuns([plan], products, actuals);
  assert.equal(runs.find((r) => r.id === "other-batch")?.remaining, 20);
  assert.equal(runs.find((r) => r.id === "unidentified")?.remaining, 20);
});
