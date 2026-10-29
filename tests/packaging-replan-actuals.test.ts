import assert from "node:assert/strict";
import test from "node:test";
import { tankReleases, validateProduction, validateProductionIssues, proposePendingPackagingVolumeCorrection, validateBrewReleases } from "../src/SERVICES/planning/productionCycle";
import { openRuns, futureTanks } from "../src/SERVICES/planning/dailyPlanner";
import { resolvePackagingBrewId, withStablePackagingIdentity } from "../src/SERVICES/planning/planIdentity";
import { plansAfterActualPackagingCompletion, mergeCompletedPackagingBack, pendingPackagingDecisions } from "../src/SERVICES/planning/packagingActuals";
import type { Settings, WeekPlan, Actual } from "../src/SERVICES/planning/planningEngine";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";

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

test("future canonical cycle keeps its own planned volume, not current physical tank remainder", () => {
  const plan = week();
  plan.brews = [{ id: "future-cycle-15", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000, batchNumber: "1700" }];
  plan.packaging = [{
    id: "future-packaging", productId: "pils-kegs", quantity: 100,
    tankId: "tank15", tankNumber: "15", batchNumber: "1700",
    brewId: "future-cycle-15", date: "2026-11-11",
  }];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 150, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([plan], settings, [tank], [], "2026-10-14"), null);
});

test("closed current batch removes unproduced pending packaging without fabricating actuals", () => {
  const plan = week();
  plan.packaging = [
    { id: "kegs-done", productId: "pils-kegs", quantity: 70, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" },
    { id: "crates-stale", productId: "pils-crates", quantity: 252, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-14", emptyTank: true },
    { id: "next-cycle", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", batchNumber: "1700", brewId: "brew-next", date: "2026-11-11" },
  ];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const source = [{ id: "tank15", tankNumber: "15", batchNumber: "1600", tankStatus: true }];
  const result = plansAfterActualPackagingCompletion([plan], products, actuals, source)[0];
  assert.equal(result.packaging[0].quantity, 70);
  // A closed tank cannot rewrite the persisted historical packaging plan.
  assert.equal(result.packaging[1].quantity, 252);
  assert.equal(result.packaging[2].quantity, 100);
  assert.equal(plan.packaging[1].quantity, 252);
});

test("open tank retains current batch packaging and does not mark it completed", () => {
  const plan = week();
  plan.packaging = [{ id: "crates", productId: "pils-crates", quantity: 252, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-14", emptyTank: true }];
  const result = plansAfterActualPackagingCompletion([plan], products, [], [{ id: "tank15", tankNumber: "15", batchNumber: "1600", action: 1 }])[0];
  assert.equal(result.packaging[0].quantity, 252);
});

test("current batch can plan emptying after partial actuals despite unpackageable residual", () => {
  const plan = week();
  plan.packaging = [
    { id: "done", productId: "pils-kegs", quantity: 70, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-12" },
    { id: "finish", productId: "pils-crates", quantity: 252, tankId: "tank15", tankNumber: "15", batchNumber: "1600", date: "2026-10-14", emptyTank: true },
  ];
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2200, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([plan], settings, [tank], actuals, "2026-10-14"), null);
  const sources = [{ id: "tank15", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", action: 1 }];
  assert.equal(tankReleases(sources, [tank], [plan], settings, actuals, "2026-10-14")[0].date, "2026-10-19");
});

test("future canonical emptying still rejects unexplained leftover volume", () => {
  const plan = week();
  plan.brews = [{ id: "future-cycle", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000, batchNumber: "1700" }];
  plan.packaging = [{ id: "future-end", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", batchNumber: "1700", brewId: "future-cycle", date: "2026-11-11", emptyTank: true }];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 100, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.match(validateProduction([plan], settings, [tank], [], "2026-10-14") ?? "", /לא ניתן לסמן סיום/);
});

test("canonical-linked current physical batch can plan emptying with process loss", () => {
  const plan = week();
  plan.brews = [{ id: "current-brew", tankId: "tank15", style: "Pils", date: "2026-09-01", liters: 3700, batchNumber: "1600" }];
  plan.packaging = [
    { id: "done", productId: "pils-kegs", quantity: 70, tankId: "tank15", tankNumber: "15", batchNumber: "1600", brewId: "current-brew", date: "2026-10-12" },
    { id: "finish", productId: "pils-crates", quantity: 250, tankId: "tank15", tankNumber: "15", batchNumber: "1600", brewId: "current-brew", date: "2026-10-14", emptyTank: true },
  ];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2200, cold: true };
  const actuals = [{ id: "a1", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([plan], settings, [tank], actuals, "2026-10-14"), null);
});

test("legacy current physical emptying without batch snapshot does not block next-week brew assignment", () => {
  const old = week();
  old.packaging = [
    { id: "completed", productId: "pils-kegs", quantity: 70, tankId: "tank15", tankNumber: "15", date: "2026-10-12" },
    { id: "finished", productId: "pils-crates", quantity: 252, tankId: "tank15", tankNumber: "15", date: "2026-10-14", emptyTank: true },
  ];
  const future = { ...week(), id: "2026-10-18", brews: [{ id: "new-15", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3200 }], packaging: [] };
  const actuals = [
    { id: "kegs", date: "2026-10-12", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "kegs", quantity: 70 },
    { id: "crates", date: "2026-10-14", tankNumber: "15", batchNumber: "1600", beerStyle: "Pils", packagingType: "bottles", quantity: 250 },
  ] as Actual[];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2100, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([old, future], settings, [tank], actuals, "2026-10-14"), null);
});

test("historical canonical current brew without batch number can end with process loss", () => {
  const old = week();
  old.brews = [{ id: "old-current", tankId: "tank15", style: "Pils", date: "2026-09-01", liters: 3700 }];
  old.packaging = [{ id: "finish", productId: "pils-crates", quantity: 250, tankId: "tank15", tankNumber: "15", brewId: "old-current", date: "2026-10-14", emptyTank: true }];
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2100, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([old], settings, [tank], [], "2026-10-14"), null);
});

test("future canonical cycle without batch number still rejects leftover volume", () => {
  const current = week();
  const future = { ...week(), id: "2026-10-18", brews: [{ id: "future", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000 }], packaging: [
    { id: "future-finish", productId: "pils-kegs", quantity: 100, tankId: "tank15", tankNumber: "15", brewId: "future", date: "2026-11-11", emptyTank: true },
  ] };
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1600", brewed: "2026-09-01", ready: "2026-10-01", liters: 2100, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.match(validateProduction([current, future], settings, [tank], [], "2026-10-14") ?? "", /לא ניתן לסמן סיום/);
});

test("empty dirty tanks 15 and 16 release next week while tank 10 uses planned emptying", () => {
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  const plan = week();
  plan.packaging = [{
    id: "finish-10", productId: "pils-crates", quantity: 250,
    tankId: "tank10", tankNumber: "10", batchNumber: "1608",
    date: "2026-10-15", emptyTank: true,
  }];
  const tanks = [
    { id: "tank10", number: "10", style: "Pils", batch: "1608", brewed: "2026-09-01", ready: "2026-10-01", liters: 1900, cold: true },
  ];
  const sources = [
    { id: "tank10", tankNumber: "10", batchNumber: "1608", beerStyle: "Pils", action: 1 },
    { id: "tank15", tankNumber: "15", batchNumber: "1609", beerStyle: "Pils", action: 3 },
    { id: "tank16", tankNumber: "16", batchNumber: "1607", beerStyle: "IPA", action: 3 },
  ];
  const releases = tankReleases(sources, tanks, [plan], settings, [], "2026-10-14");
  assert.equal(releases.find((release) => release.tankId === "tank10")?.date, "2026-10-19");
  assert.equal(releases.find((release) => release.tankId === "tank15")?.date, "2026-10-14");
  assert.equal(releases.find((release) => release.tankId === "tank16")?.date, "2026-10-14");
});

test("empty tank legacy packaging is not checked against next brew maturity", () => {
  const old = week();
  old.packaging = [{ id: "old-pils-15", productId: "pils-kegs", quantity: 71,
    tankId: "tank15", tankNumber: "15", batchNumber: "1586", date: "2026-10-15" }];
  const next = { ...week(), id: "2026-10-18",
    brews: [{ id: "next-pils-15", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000, batchNumber: "1700" }],
    packaging: [] };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.match(validateProduction([old, next], settings, futureTanks([], [old, next], settings), [], "2026-10-14") ?? "", /חסר מיכל מקור לאריזה/);
});

test("stale future brewId cannot assign next cycle maturity to physical batch", () => {
  const old = week();
  old.packaging = [{ id: "old-pils-15", productId: "pils-kegs", quantity: 71,
    tankId: "tank15", tankNumber: "15", batchNumber: "1586",
    brewId: "next-pils-15", date: "2026-10-15" }];
  const next = { ...week(), id: "2026-10-18",
    brews: [{ id: "next-pils-15", tankId: "tank15", style: "Pils", date: "2026-10-19", liters: 3000, batchNumber: "1700" }],
    packaging: [] };
  const tank = { id: "tank15", number: "15", style: "Pils", batch: "1586",
    brewed: "2026-08-25", ready: "2026-09-15", liters: 2000, cold: true };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  assert.equal(validateProduction([old, next], settings, futureTanks([tank], [old, next], settings), [], "2026-10-14"), null);
});

test("a stale future brewId never rewrites the physical packaging batch or date", () => {
  const current = week();
  current.packaging = [{ id: "pils-15-old", productId: "pils-kegs", quantity: 71,
    tankId: "tank15", tankNumber: "15", batchNumber: "1586",
    brewId: "next-15", date: "2026-10-15" }];
  const future = { ...week(), id: "2026-10-18",
    brews: [{ id: "next-15", tankId: "tank15", style: "Pils", date: "2026-10-19",
      liters: 3200, batchNumber: "1700" }], packaging: [] };
  assert.equal(resolvePackagingBrewId(current.packaging[0], [current, future]), null);
  const normalized = withStablePackagingIdentity([current, future]);
  assert.equal(normalized[0].packaging[0].batchNumber, "1586");
  assert.equal(normalized[0].packaging[0].date, "2026-10-15");
});

test("future packaging stays linked to its matching future brew", () => {
  const current = week();
  const future = { ...week(), id: "2026-10-18",
    brews: [{ id: "next-15", tankId: "tank15", style: "Pils", date: "2026-10-19",
      liters: 3200, batchNumber: "1700" }],
    packaging: [{ id: "pils-15-next", productId: "pils-kegs", quantity: 100,
      tankId: "tank15", tankNumber: "15", batchNumber: "1700", brewId: "next-15",
      date: "2026-11-11" }] };
  assert.equal(resolvePackagingBrewId(future.packaging[0], [current, future]), "next-15");
});

test("a projected next cycle cannot supply volume to an unrelated old batch", () => {
  const old = week();
  old.packaging = [{ id: "old-15", productId: "pils-kegs", quantity: 71,
    tankId: "tank15", tankNumber: "15", batchNumber: "1586",
    date: "2026-10-15", emptyTank: true }];
  const next = { ...week(), id: "2026-10-18",
    brews: [{ id: "future-15", tankId: "tank15", style: "Pils",
      date: "2026-10-19", liters: 3000, batchNumber: "1700" }], packaging: [] };
  const settings = { products, targetWeeks: 2, preferredRuns: 5, lossPercent: 10, revision: 0 };
  const projected = futureTanks([], [old, next], settings);
  const error = validateProduction([old, next], settings, projected, [], "2026-10-14");
  assert.match(error ?? "", /חסר מיכל מקור לאריזה/);
  assert.doesNotMatch(error ?? "", /לא ניתן לסמן סיום|לפני מועד ההבשלה/);
});

test("verified completed final packaging releases physical tank despite zero open balance", () => {
  const plan = week();
  plan.packaging = [{ id: "completed-final", productId: "pils-kegs",
    quantity: 100, tankId: "tank16", tankNumber: "16", batchNumber: "1607",
    date: "2026-10-13", emptyTank: true }];
  const actuals = [{ id: "a", date: "2026-10-13", tankNumber: "16",
    batchNumber: "1607", beerStyle: "Pils", packagingType: "kegs",
    quantity: 100 }] as Actual[];
  const tank = { id: "tank16", number: "16", style: "Pils",
    batch: "1607", brewed: "2026-09-01", ready: "2026-09-22",
    liters: 0, cold: true };
  const source = { id: "tank16", tankNumber: "16", batchNumber: "1607",
    beerStyle: "Pils", action: 1 };
  const settings = { products, targetWeeks: 2, preferredRuns: 5,
    lossPercent: 10, revision: 0 };
  assert.equal(openRuns([plan], products, actuals)[0].remaining, 0);
  const release = tankReleases([source], [tank], [plan], settings, actuals, "2026-10-14")[0];
  assert.equal(release.emptyDate, "2026-10-13");
  assert.equal(release.date, "2026-10-19");
});

test("a completed-looking row without matching actual cannot release a tank", () => {
  const plan = week();
  plan.packaging = [{ id: "unverified", productId: "pils-kegs",
    quantity: 100, tankId: "tank16", tankNumber: "16", batchNumber: "1607",
    date: "2026-10-13", emptyTank: true }];
  const tank = { id: "tank16", number: "16", style: "Pils",
    batch: "1607", brewed: "2026-09-01", ready: "2026-09-22",
    liters: 2000, cold: true };
  const source = { id: "tank16", tankNumber: "16", batchNumber: "1607",
    beerStyle: "Pils", action: 1 };
  const settings = { products, targetWeeks: 2, preferredRuns: 5,
    lossPercent: 10, revision: 0 };
  // A still-open plan may release on its planned date; no completed
  // execution is invented in the absence of an actual.
  assert.equal(tankReleases([source], [tank], [plan], settings, [], "2026-10-14")[0].emptyDate, null);
});

test("physical 15: already packed 250 crates and 70 kegs cannot be scheduled again tomorrow", () => {
  const original = week();
  original.packaging = [
    { id: "pils-crates-15", productId: "pils-crates", quantity: 252,
      tankId: "tank15", tankNumber: "15", batchNumber: "1586", date: "2026-10-12" },
    { id: "pils-kegs-15", productId: "pils-kegs", quantity: 71,
      tankId: "tank15", tankNumber: "15", batchNumber: "1586", date: "2026-10-15" },
  ];
  const actuals = [
    { id: "real-crates", date: "2026-10-12", tankNumber: 15, batchNumber: 1586,
      beerStyle: "Pils", packagingType: "bottles", quantity: 250, unit: "ארגזים" },
    { id: "real-kegs", date: "2026-10-13", tankNumber: 15, batchNumber: 1586,
      beerStyle: "Pils", packagingType: "kegs", quantity: 70 },
  ] as Actual[];
  const sources = [{ id: "tank15", tankNumber: 15, batchNumber: 1586, action: 3 }];
  const completed = openRuns([original], products, actuals);
  assert.deepEqual(completed.map((run) => run.remaining).sort(), [1, 2]);
  // A physical empty tank means those 1+2 unproduced estimates are cancelled,
  // never carried into another day's planning or counted as new production.
  assert.deepEqual(pendingPackagingDecisions(original, products, actuals, sources), []);
  const merged = mergeCompletedPackagingBack(original, original, products, actuals, sources);
  assert.deepEqual(merged.packaging.map((run) => [run.id, run.quantity, run.date]).sort(), [
    ["pils-crates-15", 250, "2026-10-12"],
    ["pils-kegs-15", 70, "2026-10-13"],
  ]);
  assert.deepEqual(pendingPackagingDecisions(merged, products, actuals, sources), []);
  assert.deepEqual(mergeCompletedPackagingBack(merged, merged, products, actuals, sources).packaging, merged.packaging);
});

test("an active tank retains its real unexecuted remainder when a report precedes the planned date", () => {
  const original = week();
  original.packaging = [{ id: "kegs-active", productId: "pils-kegs",
    quantity: 71, tankId: "tank15", tankNumber: "15", batchNumber: "1586", date: "2026-10-15" }];
  const actuals = [{ id: "kegs-early", date: "2026-10-13", tankNumber: 15,
    batchNumber: 1586, beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const sources = [{ id: "tank15", tankNumber: "15", batchNumber: "1586", action: 1 }];
  assert.deepEqual(pendingPackagingDecisions(original, products, actuals, sources).map((run) => [run.date, run.quantity]),
    [["2026-10-15", 1]]);
  const merged = mergeCompletedPackagingBack(original, original, products, actuals, sources);
  assert.deepEqual(merged.packaging.map((run) => [run.date, run.quantity]), [
    ["2026-10-13", 70], ["2026-10-15", 1],
  ]);
  assert.deepEqual(pendingPackagingDecisions(merged, products, actuals, sources).map((run) => run.quantity), [1]);
});

test("a report from another physical batch never cancels the planned balance", () => {
  const original = week();
  original.packaging = [{ id: "new-pils", productId: "pils-kegs", quantity: 71,
    tankId: "tank15", tankNumber: "15", batchNumber: "1700", date: "2026-10-15" }];
  const actuals = [{ id: "old-pils", date: "2026-10-13", tankNumber: "15",
    batchNumber: "1586", beerStyle: "Pils", packagingType: "kegs", quantity: 70 }] as Actual[];
  const sources = [{ id: "tank15", tankNumber: "15", batchNumber: "1586", action: 3 }];
  assert.deepEqual(pendingPackagingDecisions(original, products, actuals, sources).map((run) => run.quantity), [71]);
  assert.deepEqual(mergeCompletedPackagingBack(original, original, products, actuals, sources).packaging, original.packaging);
});

test("one-click adjustment reconciles 138 stout crates with 1039.5 L while preserving the selected day", () => {
  const stoutProducts: Settings["products"] = [{
    id: "stout-crates", sku: "stout-crates", style: "סטאוט", type: "crates",
    monthly: 42, tempo: 0, tempoDate: "2026-10-29", leadDays: 21,
  }];
  const settings: Settings = {
    products: stoutProducts, targetWeeks: 5, preferredRuns: 5,
    lossPercent: 10, revision: 0,
  };
  const physical = {
    id: "tank-3", number: "3", style: "סטאוט", batch: "1609",
    brewed: "2026-10-01", ready: "2026-10-22",
    liters: 1039.5, cold: true,
  };
  const original: WeekPlan = {
    ...week(), id: "2026-11-08", packaging: [{
      id: "stout-138", tankId: physical.id, tankNumber: "3",
      batchNumber: physical.batch, productId: stoutProducts[0].id, quantity: 138,
    }],
  };
  const scheduled: WeekPlan = {
    ...original, packaging: [{ ...original.packaging[0], date: "2026-11-09" }],
  };
  const issues = validateProductionIssues([scheduled], settings, [physical], [], "2026-10-29");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].volumeAdjustment?.maxRemainingUnits, 131);
  assert.equal(issues[0].volumeAdjustment?.requestedRemainingUnits, 138);
  assert.equal(issues[0].volumeAdjustment?.requiredLiters.toFixed(1), "1093.0");
  assert.equal(issues[0].volumeAdjustment?.availableLiters, 1039.5);
  const correction = proposePendingPackagingVolumeCorrection(
    original, scheduled, issues[0], "stout-138", stoutProducts, [original], [],
  );
  assert.ok(correction, "the planner must offer an explicit, safe quantity reduction");
  assert.equal(correction.from, 138);
  assert.equal(correction.to, 131);
  assert.equal(correction.plan.packaging[0].date, "2026-11-09");
  assert.equal(correction.plan.packaging[0].batchNumber, "1609");
  assert.equal(original.packaging[0].quantity, 138, "the original remains unchanged before approval");
  assert.equal(validateProduction([correction.plan], settings, [physical], [], "2026-10-29"), null);
  assert.ok(131 * 24 * .33 <= physical.liters);
  assert.ok(132 * 24 * .33 > physical.liters);

  const reported: Actual[] = [{
    id: "already-packed", date: "2026-11-09", tankNumber: "3",
    batchNumber: "1609", beerStyle: "סטאוט", packagingType: "bottles",
    quantity: 24, unit: "ארגזים",
  }];
  assert.equal(proposePendingPackagingVolumeCorrection(
    original, scheduled, issues[0], "stout-138", stoutProducts, [original], reported,
  ), null, "previously completed physical packaging cannot be silently rewritten");
  assert.equal(proposePendingPackagingVolumeCorrection(
    original, { ...scheduled, packaging: [{ ...scheduled.packaging[0], tankId: "tank-4" }] },
    issues[0], "stout-138", stoutProducts, [original], [],
  ), null, "never apply a reduction after an unrelated tank reassignment");
});

test("weekly recommendation is capped at 131 crates when stout physical volume is 1039.5 L", () => {
  const stout: Settings["products"][number] = {
    id: "stout-crates", sku: "stout-crates", style: "סטאוט", type: "crates",
    monthly: 42, tempo: 0, tempoDate: "2026-10-29", leadDays: 21,
  };
  const settings: Settings = {
    products: [stout], targetWeeks: 5, totalTargetWeeks: 8.5,
    preferredRuns: 5, lossPercent: 10, revision: 0,
  };
  const tank = {
    id: "tank-3", number: "3", batch: "1609", style: "סטאוט",
    brewed: "2026-10-01", ready: "2026-10-22", liters: 1039.5, cold: true,
  };
  const model = buildWeeklyPlanningModel({
    settings, pallets: [], tanks: [tank], plans: [], actuals: [],
    sources: [{ id: tank.id, tankNumber: 3, beerStyle: tank.style,
      batchNumber: tank.batch, brewDate: "01/10/2026", action: 1 }],
    today: "2026-10-29", week: "2026-11-08", holidays: [], shipments: [],
  });
  assert.equal(model.packagingRecommendation.find((r) => r.tankNumber === "3")?.quantity, 131);
});
