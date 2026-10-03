import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product, type Tank } from "../src/SERVICES/planning/planningEngine";
import { tankReleases } from "../src/SERVICES/planning/productionCycle";

const product: Product = {
  id: "wheat-crates",
  sku: "wheat-crates",
  style: "חיטה",
  type: "crates",
  monthly: 100,
  tempo: 0,
  tempoDate: "2026-09-30",
  leadDays: 21,
};

const settings = { ...defaultSettings(), products: [product] };

test("physical DD/MM brewDate resolves to the canonical current cycle and releases after emptying", () => {
  const tank: Tank = {
    id: "tank-2",
    number: "2",
    batch: "1598",
    style: "חיטה",
    brewed: "2026-09-28",
    ready: "2026-10-20",
    liters: 1100,
    cold: true,
  };
  const brewWeek = {
    ...emptyWeek("2026-09-27"),
    brews: [{
      id: "brew-1598",
      style: "חיטה",
      tankId: "tank-2",
      date: "2026-09-28",
      liters: 1100,
    }],
  };
  const packagingWeek = {
    ...emptyWeek("2026-10-25"),
    packaging: [{
      id: "empty-1598",
      productId: product.id,
      quantity: 139,
      tankId: "tank-2",
      tankNumber: "2",
      brewId: "brew-1598",
      date: "2026-10-29",
      emptyTank: true,
    }],
  };

  const [release] = tankReleases(
    [{
      id: "tank-2",
      tankNumber: 2,
      batchNumber: "1598",
      brewDate: "28/09/2026",
      beerStyle: "חיטה",
      beerVolume: 1245,
      tankStatus: false,
      action: 1,
    }],
    [tank],
    [brewWeek, packagingWeek],
    settings,
    [],
    "2026-09-30",
  );

  assert.equal(release.emptyDate, "2026-10-29");
  assert.equal(release.date, "2026-11-02");
  assert.equal(release.remaining, 0);
});