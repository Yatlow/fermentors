import test from "node:test";
import assert from "node:assert/strict";
import { projectHybridFermentationMilestones } from "../src/SERVICES/cellering/styleFermentationForecast";
import { requiresFermentationPlatoPh } from "../src/SERVICES/dashboard/cellarGrace";
import type { StyleAverages } from "../src/SERVICES/getAndPost/getStyleAverages";

const styleDays: Record<string, number> = {
  "0": 13.5, "1": 10, "2": 8, "3": 6.5, "4": 5.2,
  "5": 4.6, "6": 4.2, "7": 3.8, "8": 3.5, "9": 3.4,
  "10": 3.33, "11": 3.3, "12": 3.27,
};
const curve = (style: string, count = 5): StyleAverages => ({
  style,
  batchCount: 30,
  sampleCount: 100,
  updatedAt: "2026-11-03T12:00:00Z",
  days: Object.fromEntries(Object.entries(styleDays).map(([day, plato]) => [day, {
    plato, pH: 4.5, temp: 20, pressure: 0,
    carbonation: null, sampleCount: 12, batchCount: count,
    platoBatchCount: count, platoSampleCount: count,
  }])),
});
const specs = {
  tolorances: { dryHopMinPlatoIpa: 8, shutTankMinPlato: 5 },
  fermentationEndPlato: { ipa: 3.6, "חיטה": 2.7 },
};
const tank = (beerStyle: string, extra = {}) => ({
  id: "t10", tankNumber: "10", beerStyle, brewDate: "01/11/2026",
  stage: { name: "בתסיסה" }, ...extra,
});

test("zero readings: non-linear style curve predicts a future dry-hop check", () => {
  const rows = projectHybridFermentationMilestones(tank("IPA"), [], "2026-11-02", specs, curve("IPA"));
  const hop = rows.find((row) => row.id.includes(":plato-recheck:"));
  assert.equal(hop?.dueDate, "2026-11-04");
  assert.match(hop?.basis ?? "", /טרם נמדד פלאטו/);
});

test("zero readings: non-hoppy style uses its own curve for the closure check", () => {
  const rows = projectHybridFermentationMilestones(tank("חיטה"), [], "2026-11-02", specs, curve("חיטה"));
  const close = rows.find((row) => row.id.includes(":plato-recheck:"));
  assert.equal(close?.dueDate, "2026-11-06");
  assert.match(close?.title ?? "", /סגירת מיכל/);
});

test("one reading adjusts the style curve; the uncalibrated estimate is not reused", () => {
  const rows = [{ id: "2026-11-02_0830", plato: 12 }];
  const result = projectHybridFermentationMilestones(tank("IPA"), rows, "2026-11-02", specs, curve("IPA"));
  const hop = result.find((row) => row.id.includes(":plato-recheck:"));
  assert.equal(hop?.dueDate, "2026-11-05");
  assert.match(hop?.basis ?? "", /מותאמת לפלאטו/);
});

test("cooling check uses actual warm yeast drop, expected style final-Plato and flat-curve evidence", () => {
  const rows = [
    { id: "2026-11-01_0800", plato: 13.5 },
    { id: "2026-11-02_0800", plato: 10, notes: "הורדת שמרים 4 דליים" },
  ];
  const result = projectHybridFermentationMilestones(tank("IPA"), rows, "2026-11-02", specs, curve("IPA"));
  const cooling = result.find((row) => row.id.includes(":cooling-readiness:"));
  assert.equal(cooling?.dueDate, "2026-11-09");
  assert.match(cooling?.basis ?? "", /יציבות בפועל/);
  const withoutYeast = rows.map((row) => ({ ...row, notes: undefined }));
  const conditional = projectHybridFermentationMilestones(tank("IPA"), withoutYeast,
    "2026-11-02", specs, curve("IPA"));
  assert.equal(conditional.some((row) => row.id.includes(":cooling-readiness:")), false);
  assert.equal(conditional.find((row) => row.id.includes(":cooling-conditions:"))?.dueDate, "2026-11-09");
  assert.match(conditional.find((row) => row.id.includes(":cooling-conditions:"))?.basis ?? "",
    /מותנה בהורדת שמרים חמה/);
  assert.equal(projectHybridFermentationMilestones(tank("IPA"), [...rows, {
    id: "2026-11-02_0900", notes: "קירור מיכל ל1°C",
  }], "2026-11-02", specs, curve("IPA")).some((row) => row.id.includes(":cooling-readiness:")), false);
});

test("an early threshold crossing on a steep curve is NOT itself a cooling forecast", () => {
  const fast = curve("IPA");
  fast.days["5"] = { ...fast.days["5"], plato: 3.4 };
  fast.days["6"] = { ...fast.days["6"], plato: 2.5 };
  const rows = [{ id: "2026-11-02_0800", notes: "הורדת שמרים 4 דליים" }];
  const result = projectHybridFermentationMilestones(tank("IPA"), rows, "2026-11-02", specs, fast);
  const cooling = result.find((row) => row.id.includes(":cooling-readiness:"));
  assert.equal(cooling?.dueDate, "2026-11-09", "the first stable portion follows the steep segment");
});

test("batch-day sample size is mandatory: global batchCount and total sampleCount do not suffice", () => {
  const old = curve("IPA");
  for (const day of Object.values(old.days)) delete day.platoBatchCount;
  assert.deepEqual(projectHybridFermentationMilestones(tank("IPA"), [], "2026-11-02", specs, old), []);
  const sparse = curve("IPA", 2);
  assert.deepEqual(projectHybridFermentationMilestones(tank("IPA"), [], "2026-11-02", specs, sparse), []);
});

test("two fresh batch readings remain the linear fallback without a reliable style curve", () => {
  const readings = [{ id: "2026-11-02_0800", plato: 10 }, { id: "2026-11-03_0800", plato: 9 }];
  const results = projectHybridFermentationMilestones(tank("IPA"), readings, "2026-11-03", specs, null);
  assert.equal(results.find((row) => row.id.includes(":plato-recheck:"))?.dueDate, "2026-11-05");
  assert.match(results.find((row) => row.id.includes(":plato-recheck:"))?.basis ?? "", /ירידת פלאטו/);
});

test("no action duplicates after dry-hop / closure, no forecasts for cold tanks", () => {
  const dryhop = projectHybridFermentationMilestones(tank("IPA"),
    [{ id: "2026-11-02_0800", notes: "הוספת כשות" }], "2026-11-02", specs, curve("IPA"));
  assert.equal(dryhop.some((row) => row.id.includes(":plato-recheck:")), false);
  const close = projectHybridFermentationMilestones(tank("חיטה"),
    [{ id: "2026-11-02_0800", notes: "סגירת נשם" }], "2026-11-02", specs, curve("חיטה"));
  assert.equal(close.some((row) => row.id.includes(":plato-recheck:")), false);
  assert.deepEqual(projectHybridFermentationMilestones(tank("IPA", { stage: { name: "קר" } }),
    [], "2026-11-02", specs, curve("IPA")), []);
});

test("blank temperature in active fermentation must require Plato and pH", () => {
  const base = { stage: { name: "בתסיסה" } };
  for (const temp of [undefined, null, "", "—", "x", "  "]) {
    assert.equal(requiresFermentationPlatoPh({ ...base, currentData: { temp } }), true);
  }
  assert.equal(requiresFermentationPlatoPh({ ...base, currentData: { temp: 9 } }), false);
  assert.equal(requiresFermentationPlatoPh({ ...base, currentData: { temp: 20 } }), true);
  assert.equal(requiresFermentationPlatoPh({ stage: { name: "קר" }, currentData: { temp: null } }), false);
});
