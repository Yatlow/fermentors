import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyWeek } from "../src/SERVICES/planning/planningEngine";
import { plannedPackagingDateForTank, projectPlannedPackagingMaps } from "../src/SERVICES/planning/plannedPackagingProjection";

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
