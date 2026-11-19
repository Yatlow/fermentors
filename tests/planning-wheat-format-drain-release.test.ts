import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import { reconcileEditedPackagingEmptying, splitWeeklyCrateRuns } from "../src/SERVICES/planning/packagingEmptying";
import {
  tankReleases, validateBrewReleases, validateProduction,
  type TankSource,
} from "../src/SERVICES/planning/productionCycle";
import { validatePlanningDecisionChange } from "../src/SERVICES/planning/planningDecisionSafety";
import { planningWeekIssues } from "../src/SERVICES/planning/planningValidation";

const today = "2026-11-19";
const wheatKegs: Product = {
  id: "wheat-kegs", sku: "wheat-kegs", style: "חיטה", type: "kegs",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const wheatCrates: Product = {
  id: "wheat-crates", sku: "wheat-crates", style: "חיטה", type: "crates",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const products = [wheatKegs, wheatCrates];
const settings = { ...defaultSettings(), products };
const tank: Tank = {
  id: "tank-7", number: "7", style: "חיטה", batch: "1610",
  brewed: "2026-10-26", ready: "2026-11-16", liters: 2080, cold: true,
};
const source: TankSource = {
  id: "tank-7", tankNumber: 7, batchNumber: "1610", brewDate: "26/10/2026",
  beerStyle: "חיטה", beerVolume: 2080, action: 1, tankStatus: false,
};
const oldBrew: WeekPlan = {
  ...emptyWeek("2026-10-25"),
  brews: [{
    id: "wheat-1610", tankId: "tank-7", style: "חיטה",
    date: "2026-10-26", liters: 2100, batchNumber: "1610",
  }],
};
const packagingWeek: WeekPlan = {
  ...emptyWeek("2026-11-22"),
  packaging: [{
    id: "wheat-final", tankId: "tank-7", tankNumber: "7",
    brewId: "wheat-1610", batchNumber: "1610",
    productId: wheatKegs.id, quantity: 104, emptyTank: true,
  }],
};
const nextBrew: WeekPlan = {
  ...emptyWeek("2026-11-29"),
  brews: [{
    id: "wheat-1619", tankId: "tank-7", style: "חיטה",
    date: "2026-11-30", liters: 2100, batchNumber: "1619",
  }],
};
const available = new Map([["tank-7", 2080]]);
const before = [oldBrew, packagingWeek, nextBrew];
const edited = [{
  ...packagingWeek.packaging[0], productId: wheatCrates.id,
  quantity: 252, emptyTank: undefined,
}];

test("tank 7: 104 kegs to 252 crates preserves same-batch final emptying and explicitly warns about 84.16 L", () => {
  const result = reconcileEditedPackagingEmptying(
    edited, packagingWeek.packaging, products, available, [tank],
  );
  assert.equal(result.packaging[0].emptyTank, true);
  assert.equal(result.packaging[0].quantity, 252);
  assert.equal(result.packaging[0].productId, wheatCrates.id);
  assert.equal(result.confirmations.length, 1);
  assert.ok(Math.abs(result.confirmations[0].remainderLiters - 84.16) < 0.001);
  assert.equal(result.confirmations[0].tankNumber, "7");
  const afterWeek = { ...packagingWeek, packaging: result.packaging };
  const after = [oldBrew, afterWeek, nextBrew];
  // Weekly packaging is intentionally undated; production-day validation runs only after scheduling.
  assert.equal(tankReleases([source], [tank], after, settings, [], today)[0].emptyDate, "2026-11-26");
  assert.equal(validateBrewReleases([source], [tank], after, settings, [], today), null);
  assert.equal(validatePlanningDecisionChange({
    before, after, edited: afterWeek, previous: packagingWeek,
    settings, tanks: [tank], sources: [source], actuals: [], today,
  }), null);
});

test("previously inferred final drain without an explicit flag is retained on format change", () => {
  const withoutFlag = [{ ...packagingWeek.packaging[0], emptyTank: undefined }];
  const next = reconcileEditedPackagingEmptying(
    edited, withoutFlag, products, available, [tank],
  );
  assert.equal(next.packaging[0].emptyTank, true,
    "104*20 L was a full draining decision even in a legacy week without emptyTank");
  assert.equal(next.confirmations.length, 1);
});

test("a different batch/tank/cycle cannot inherit the last-packaging marker", () => {
  const moved = [
    { ...edited[0], tankId: "tank-8", tankNumber: "8", brewId: undefined },
    { ...edited[0], batchNumber: "1611" },
    { ...edited[0], batchNumber: "1611", brewId: undefined },
    { ...edited[0], brewId: "different-brew" },
  ];
  for (const change of moved) {
    const result = reconcileEditedPackagingEmptying(
      [change], packagingWeek.packaging, products,
      new Map([["tank-7", 2080], ["tank-8", 2080], ["planned:different-brew", 2080]]),
      [tank, { ...tank, id: "tank-8", number: "8", batch: "1609" }],
    );
    assert.equal(result.packaging[0].emptyTank, false);
    assert.equal(result.confirmations.length, 0);
  }
});

test("partial crates without a terminal decision keep the subsequent brew blocked", () => {
  const oldPartial = [{ ...packagingWeek.packaging[0], quantity: 50, emptyTank: false }];
  const newPartial = reconcileEditedPackagingEmptying(
    [{ ...oldPartial[0], productId: wheatCrates.id, quantity: 150 }],
    oldPartial, products, available, [tank],
  );
  assert.equal(newPartial.packaging[0].emptyTank, false);
  const weeks = [oldBrew, { ...packagingWeek, packaging: newPartial.packaging }, nextBrew];
  assert.match(validateBrewReleases([source], [tank], weeks, settings, [], today) ?? "", /ללא ריקון/);
});

test("an undated final commitment cannot release an immature tank or one that is packaged in the following week", () => {
  const result = reconcileEditedPackagingEmptying(edited, packagingWeek.packaging, products, available, [tank]);
  const after = [oldBrew, { ...packagingWeek, packaging: result.packaging }, nextBrew];
  const immature = { ...tank, ready: "2026-12-01" };
  assert.match(validateBrewReleases([source], [immature], after, settings, [], today) ?? "", /מיכל 7/);
  const late = [oldBrew, { ...after[1], id: "2026-11-29" }, nextBrew];
  assert.match(validateBrewReleases([source], [tank], late, settings, [], today) ?? "", /מיכל 7/);
});

test("262 wheat crates replace 104 kegs as 252 + 10 undated runs, clearing tank 7 before the 30 Nov brew", () => {
  const weekly = { ...edited[0], quantity: 262, emptyTank: undefined };
  const split = splitWeeklyCrateRuns([weekly], products);
  assert.deepEqual(split.map((run) => run.quantity), [252, 10]);
  assert.deepEqual(split.map((run) => run.date), [undefined, undefined]);
  assert.equal(split[0].id, "wheat-final");
  assert.equal(split[1].id, "wheat-final:bottles:1");

  const reconciled = reconcileEditedPackagingEmptying(
    split, packagingWeek.packaging, products, available, [tank],
  );
  assert.deepEqual(reconciled.packaging.map((run) => run.emptyTank), [false, true]);
  assert.equal(reconciled.confirmations.length, 0, "only ~5 L remains, no exceptional waste");
  const editedWeek = { ...packagingWeek, packaging: reconciled.packaging };
  const weeks = [oldBrew, editedWeek, nextBrew];
  assert.equal(tankReleases([source], [tank], weeks, settings, [], today)[0].emptyDate, "2026-11-26");
  assert.equal(validateBrewReleases([source], [tank], weeks, settings, [], today), null);
  assert.equal(validatePlanningDecisionChange({
    before, after: weeks, edited: editedWeek, previous: packagingWeek,
    settings, tanks: [tank], sources: [source], actuals: [], today,
  }), null);

  const dated = { ...editedWeek, packaging: [
    { ...reconciled.packaging[0], date: "2026-11-23" },
    { ...reconciled.packaging[1], date: "2026-11-24" },
  ] };
  assert.equal(validateProduction([oldBrew, dated, nextBrew], settings, [tank], [], today), null);
  assert.equal(validateBrewReleases(
    [source], [tank], [oldBrew, dated, nextBrew], settings, [], today,
  ), null);
});

test("Sunday pre-assigned 262 crates becomes 168 Sunday + 94 unscheduled, never overbooking Sunday", () => {
  const single = [{ ...edited[0], date: "2026-11-22", quantity: 262 }];
  const split = splitWeeklyCrateRuns(single, products);
  assert.deepEqual(split.map((run) => run.quantity), [168, 94]);
  assert.deepEqual(split.map((run) => run.date), ["2026-11-22", undefined]);
  const result = reconcileEditedPackagingEmptying(split, packagingWeek.packaging, products, available, [tank]);
  assert.equal(result.packaging[1].emptyTank, true);
  const dated = { ...packagingWeek, packaging: [
    result.packaging[0], { ...result.packaging[1], date: "2026-11-23" },
  ] };
  assert.equal(validateProduction([oldBrew, dated, nextBrew], settings, [tank], [], today), null);
});

test("a single 262-crate dated shift remains blocked by daily capacity", () => {
  const impossible = { ...packagingWeek, packaging: [
    { ...edited[0], quantity: 262, date: "2026-11-23", emptyTank: true },
  ] };
  const err = validateProduction([oldBrew, impossible, nextBrew], settings, [tank], [], today);
  // Daily production capacity is checked by the shared week validator, not
  // by the tank-source volume validator.
  assert.equal(err, null);
  assert.match(planningWeekIssues(impossible, settings, [oldBrew, impossible, nextBrew], today).join(";"), /262.*252/);
});
