import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyWeek } from "../src/SERVICES/planning/planningEngine";
import { packagingIndicatorsForTanks, plannedPackagingDateForTank, projectPlannedPackagingMaps } from "../src/SERVICES/planning/plannedPackagingProjection";

test("dashboard finds dated packaging for a physical current cycle that predates planning brews", () => {
  const week = {
    ...emptyWeek("2026-09-27"),
    packaging: [{
      id: "current-1571-kegs",
      productId: "hoppy-kegs",
      quantity: 194.9,
      tankId: "8",
      tankNumber: "8",
      batchNumber: "1571",
      date: "2026-10-01",
      emptyTank: true,
    }],
  };
  const maps = projectPlannedPackagingMaps([week], "2026-09-30");
  assert.equal(plannedPackagingDateForTank(maps, { tankId: "8", tankNumber: 8, batchNumber: "#1571" }), "2026-10-01");
});

test("dashboard keeps current-cycle snapshot bridge when row carries a stale/unprojected brewId", () => {
  const week = {
    ...emptyWeek("2026-09-27"),
    packaging: [{
      id: "current-1571-kegs",
      productId: "hoppy-kegs",
      quantity: 194.9,
      tankId: "8",
      tankNumber: "8",
      batchNumber: "1571",
      brewId: "historical-brew-1571",
      date: "2026-10-01",
      emptyTank: true,
    }],
  };
  const maps = projectPlannedPackagingMaps([week], "2026-09-30");
  assert.equal(plannedPackagingDateForTank(maps, { tankId: "8", tankNumber: "8", batchNumber: "1571" }), "2026-10-01");
});

test("future canonical cycle does not leak its packaging to an older batch on the same tank", () => {
  const brewWeek = {
    ...emptyWeek("2026-10-04"),
    brews: [{ id: "brew-1605", style: "הופי לאגר", tankId: "8", date: "2026-10-05", liters: 3000, batchNumber: "1605" }],
  };
  const packagingWeek = {
    ...emptyWeek("2026-10-25"),
    packaging: [{ id: "pack-1605", productId: "hoppy-kegs", quantity: 100, tankId: "8", tankNumber: "8", batchNumber: "1605", brewId: "brew-1605", date: "2026-10-29", emptyTank: true }],
  };
  const maps = projectPlannedPackagingMaps([brewWeek, packagingWeek], "2026-09-30");
  assert.equal(plannedPackagingDateForTank(maps, { tankId: "8", tankNumber: "8", batchNumber: "1571" }), null);
  assert.equal(plannedPackagingDateForTank(maps, { tankId: "8", tankNumber: "8", batchNumber: "1605" }), "2026-10-29");
});

test("dashboard reprojects tank 8 and 14 dates immediately when the shared plan changes", () => {
  const oldWeek = {
    ...emptyWeek("2026-11-08"),
    packaging: [
      { id: "tank8", productId: "wheat-crates", tankId: "tank-8",
        tankNumber: "8", batchNumber: "1605", date: "2026-11-12", quantity: 105 },
      { id: "tank14", productId: "pale-crates", tankId: "tank-14",
        tankNumber: "14", batchNumber: "1594", date: "2026-11-08", quantity: 77 },
    ],
  };
  const revisedWeek = {
    ...oldWeek,
    packaging: [
      { ...oldWeek.packaging[0], date: "2026-11-08" },
      { ...oldWeek.packaging[1], date: "2026-11-11", quantity: 252 },
      { ...oldWeek.packaging[1], id: "tank14-remainder", date: "2026-11-12", quantity: 77 },
    ],
  };
  const activeTanks = [
    { id: "tank-8", tankNumber: "8", batchNumber: "1605" },
    { id: "tank-14", tankNumber: "14", batchNumber: "1594" },
  ];
  const before = packagingIndicatorsForTanks(
    projectPlannedPackagingMaps([oldWeek], "2026-11-08"), activeTanks,
  );
  assert.deepEqual(before.dates, {
    "tank-8": "2026-11-12",
    "tank-14": "2026-11-08",
  });
  const after = packagingIndicatorsForTanks(
    projectPlannedPackagingMaps([revisedWeek], "2026-11-08"), activeTanks,
  );
  assert.deepEqual(after.dates, {
    "tank-8": "2026-11-08",
    "tank-14": "2026-11-11",
  }, "the earliest remaining packaging date is shown; tank 14 also packs on Thursday");
  assert.deepEqual(after.undatedWeeks, {});
  assert.equal(after.dates["tank-14"] === before.dates["tank-14"], false);
});

test("dashboard removes a stale dated card when the plan becomes undated", () => {
  const week = {
    ...emptyWeek("2026-11-08"),
    packaging: [{ id: "tank8", productId: "wheat-crates",
      tankId: "tank-8", tankNumber: "8", batchNumber: "1605",
      date: "2026-11-08", quantity: 105 }],
  };
  const tank = [{ id: "tank-8", tankNumber: "8", batchNumber: "1605" }];
  const planned = packagingIndicatorsForTanks(
    projectPlannedPackagingMaps([week], "2026-11-08"), tank,
  );
  const waiting = packagingIndicatorsForTanks(
    projectPlannedPackagingMaps([{ ...week, packaging: [{ ...week.packaging[0], date: undefined }] }], "2026-11-08"), tank,
  );
  assert.equal(planned.dates["tank-8"], "2026-11-08");
  assert.deepEqual(waiting.dates, {});
  assert.equal(waiting.undatedWeeks["tank-8"], "2026-11-08");
});
