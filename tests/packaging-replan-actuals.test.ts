import assert from "node:assert/strict";
import test from "node:test";
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
