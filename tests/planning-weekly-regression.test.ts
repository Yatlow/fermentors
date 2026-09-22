import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product, type Tank } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import {
  buildShipmentRecommendation,
  nominalPlanningUnits,
} from "../src/SERVICES/planning/shipmentRecommendation";
import { shipmentDecisionPickOptions } from "../src/SERVICES/planning/shipmentDecisionPicking";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";
import {
  brewLitersForSize,
  brewSizeLabel,
  normalizeEmptyTankFlagsForSchedule,
  tankReleases,
} from "../src/SERVICES/planning/productionCycle";

const today = "2026-09-13";
const product: Product = {
  id: "ipa-crates",
  sku: "ipa-crates",
  style: "IPA",
  type: "crates",
  monthly: 294,
  tempo: 1000,
  tempoDate: today,
  leadDays: 21,
};
const kegProduct: Product = {
  ...product,
  id: "ipa-kegs",
  sku: "ipa-kegs",
  type: "kegs",
};
const settings = {
  ...defaultSettings(),
  targetWeeks: 5,
  totalTargetWeeks: 8.5,
  products: [product],
};

function pallet(id: string, quantity: number, itemType: "crates" | "kegs" = "crates"): Pallet {
  return {
    id,
    quantity,
    itemType,
    beerStyle: itemType === "kegs" ? "הופי לאגר" : "IPA",
    zone: "cooler",
    expiryDateStr: "31/12/2026",
    heightUnits: 1,
    cell: { side: "right", col: 1, row: 2 },
    orderInCell: 0,
  };
}

test("a partial physical pallet counts as one whole planning pallet", () => {
  const result = buildShipmentRecommendation(settings, new Map([
    [product.id, { breweryUnits: 50, tempoUnits: 0 }],
  ]));
  assert.equal(result.recommendation[0]?.quantity, 84);
  assert.equal(result.recommendation[0]?.pallets, 1);
});

test("same-week packaging dependency uses nominal pallet capacity of opening stock", () => {
  assert.equal(nominalPlanningUnits(kegProduct, 13), 20);
  assert.equal(nominalPlanningUnits(kegProduct, 40), 40);
  assert.equal(nominalPlanningUnits(product, 56), 84);
});

test("tank empty flag follows the later scheduled split regardless of package type", () => {
  const week = {
    ...emptyWeek("2026-09-27"),
    packaging: [
      {
        id: "bottles",
        productId: product.id,
        quantity: 56,
        tankId: "tank-wheat",
        date: "2026-09-30",
        emptyTank: false,
      },
      {
        id: "kegs",
        productId: kegProduct.id,
        quantity: 50,
        tankId: "tank-wheat",
        date: "2026-09-28",
        emptyTank: true,
      },
    ],
  };

  const normalized = normalizeEmptyTankFlagsForSchedule(week);
  assert.equal(
    normalized.packaging.find((run) => run.id === "kegs")?.emptyTank,
    false,
  );
  assert.equal(
    normalized.packaging.find((run) => run.id === "bottles")?.emptyTank,
    true,
  );
});

test("shipment picking treats a partial as a nominal pallet only when needed", () => {
  const partial = shipmentDecisionPickOptions([pallet("partial", 50)], 84, 84)[0];
  assert.equal(partial.selected.length, 1);
  assert.equal(partial.actualTotal, 50);
  assert.equal(partial.nominalCovered, 84);
  assert.equal(partial.missingNominal, 0);
  assert.equal(partial.partialEquivalentGap, 34);

  const tiny = { ...pallet("tiny", 4, "kegs"), cell: { side: "right" as const, col: 1, row: 3 }, orderInCell: 0 };
  const fullA = { ...pallet("full-a", 20, "kegs"), cell: { side: "right" as const, col: 1, row: 2 }, orderInCell: 0 };
  const fullB = { ...pallet("full-b", 20, "kegs"), cell: { side: "right" as const, col: 1, row: 1 }, orderInCell: 0 };
  const hoppy = shipmentDecisionPickOptions([tiny, fullA, fullB], 40, 20)[0];
  assert.deepEqual(hoppy.selected.map((p) => p.id).sort(), ["full-a", "full-b"]);
  assert.equal(hoppy.actualTotal, 40);
});

test("future-week opening stock carries prior packaging and shipment decisions but not selected-week sales", () => {
  const week38 = {
    ...emptyWeek("2026-09-13"),
    packaging: [{
      id: "pack-before",
      productId: product.id,
      quantity: 84,
      tankId: "tank-2",
    }],
    deliveries: [{
      id: "ship-before",
      productId: product.id,
      quantity: 84,
      dispatchDate: "2026-09-20",
      arrivalDate: "2026-09-20",
    }],
  };

  const projected = buildWeekStartProjection({
    settings,
    pallets: [pallet("stock-a", 84), pallet("stock-b", 84)],
    plans: [week38],
    actuals: [],
    today,
    week: "2026-09-27",
  }).get(product.id)!;

  assert.equal(projected.tempoUnits, 944);
  assert.equal(projected.packagingBeforeWeek, 84);
  assert.equal(projected.shipmentsBeforeWeek, 84);
  assert.equal(projected.breweryUnits, 168);
});

test("selected week sales are not deducted from the opening coverage", () => {
  const projected = buildWeekStartProjection({
    settings,
    pallets: [],
    plans: [],
    actuals: [],
    today,
    week: "2026-09-20",
  }).get(product.id)!;

  assert.equal(projected.tempoUnits, 930);
});

test("an explicit emptyTank packaging decision releases the tank despite a liters rounding heel", () => {
  const localSettings = { ...settings, products: [product, kegProduct] };
  const tank: Tank = {
    id: "tank-5",
    number: "5",
    batch: "55",
    style: "IPA",
    brewed: "2026-08-01",
    ready: today,
    liters: 3300,
    cold: true,
  };
  const plan = {
    ...emptyWeek(today),
    packaging: [{
      id: "kegs-empty",
      productId: kegProduct.id,
      quantity: 160,
      date: "2026-09-16",
      tankId: tank.id,
      tankNumber: tank.number,
      emptyTank: true,
    }],
  };
  const releases = tankReleases(
    [{ id: tank.id, tankNumber: 5, beerStyle: "IPA", beerVolume: 3300, tankStatus: false, action: 1 }],
    [tank],
    [plan],
    localSettings,
    [],
    today,
  );

  assert.equal(releases[0].emptyDate, "2026-09-16");
  assert.equal(releases[0].date, "2026-09-21");
  assert.equal(releases[0].remaining, 0);
});

test("brew size helpers keep weekly editing on single/double/triple labels", () => {
  assert.equal(brewSizeLabel(1100), "בודד");
  assert.equal(brewSizeLabel(2200), "כפול");
  assert.equal(brewSizeLabel(3200), "משולש");
  assert.equal(brewSizeLabel(brewLitersForSize("IPA", "כפול")), "כפול");
});

test("unassigned brews from week 38 keep their tanks reserved in week 39", () => {
  const week38 = {
    ...emptyWeek("2026-09-13"),
    brews: [0, 1, 2].map((i) => ({
      id: `brew-${i}`,
      style: "IPA",
      tankId: "",
      date: "2026-09-14",
      liters: 2500,
    })),
  };
  const sources = Array.from({ length: 5 }, (_, i) => ({
    id: `tank-${i + 2}`,
    tankNumber: i + 2,
    tankStatus: true,
    beerVolume: 2500,
  }));

  const model = buildWeeklyPlanningModel({
    settings,
    pallets: [],
    tanks: [],
    plans: [week38],
    actuals: [],
    sources,
    today,
    week: "2026-09-20",
    holidays: [],
    shipments: [],
  });

  assert.equal(model.availableBrewTanks, 2);
  assert.equal(model.brewTankCapacity, 2);
});

test("week 39 brews do not consume tanks that only become free in week 40", () => {
  const readySources = [2, 3, 4].map((tankNumber) => ({
    id: `ready-${tankNumber}`,
    tankNumber,
    tankStatus: true,
    beerVolume: 2500,
  }));
  const occupiedTanks: Tank[] = [5, 6, 7, 8].map((tankNumber) => ({
    id: `occupied-${tankNumber}`,
    number: String(tankNumber),
    batch: `batch-${tankNumber}`,
    style: "IPA",
    brewed: "2026-08-01",
    ready: "2026-09-20",
    liters: 2500,
    cold: true,
  }));
  const occupiedSources = occupiedTanks.map((tank) => ({
    id: tank.id,
    tankNumber: Number(tank.number),
    beerStyle: "IPA",
    beerVolume: 2500,
    tankStatus: false,
    action: 1,
  }));
  const week39 = {
    ...emptyWeek("2026-09-20"),
    packaging: occupiedTanks.map((tank, i) => ({
      id: `empty-${i}`,
      productId: product.id,
      quantity: 252,
      date: "2026-09-24",
      tankId: tank.id,
      tankNumber: tank.number,
      emptyTank: true,
    })),
    brews: [0, 1, 2].map((i) => ({
      id: `week39-brew-${i}`,
      style: "IPA",
      tankId: "",
      date: "2026-09-21",
      liters: 2500,
    })),
  };

  const model = buildWeeklyPlanningModel({
    settings,
    pallets: [],
    tanks: occupiedTanks,
    plans: [week39],
    actuals: [],
    sources: [...readySources, ...occupiedSources],
    today,
    week: "2026-09-27",
    holidays: [],
    shipments: [],
  });

  assert.equal(model.brewTankCapacity, 4);
  assert.equal(model.availableBrewTanks, 4);
  assert.deepEqual(
    model.brewTankOptions.map((option) => option.tankNumber),
    ["5", "6", "7", "8"],
  );
});

test("undated weekly keg packaging waits for tank readiness and releases it next week", () => {
  const localSettings = { ...settings, products: [product, kegProduct] };
  const tank: Tank = {
    id: "tank-2",
    number: "2",
    batch: "batch-2",
    style: "IPA",
    brewed: "2026-08-15",
    ready: "2026-09-23",
    liters: 1071,
    cold: true,
  };
  const week39 = {
    ...emptyWeek("2026-09-20"),
    deliveries: [{
      id: "early-shipment",
      productId: product.id,
      quantity: 84,
      dispatchDate: "2026-09-21",
      arrivalDate: "2026-09-21",
    }],
    packaging: [{
      id: "tank-2-kegs",
      productId: kegProduct.id,
      quantity: 53,
      tankId: tank.id,
      tankNumber: tank.number,
    }],
  };

  const model = buildWeeklyPlanningModel({
    settings: localSettings,
    pallets: [],
    tanks: [tank],
    plans: [week39],
    actuals: [],
    sources: [{
      id: tank.id,
      tankNumber: 2,
      beerStyle: "IPA",
      beerVolume: 1190,
      tankStatus: false,
      action: 1,
    }],
    today,
    week: "2026-09-27",
    holidays: [],
    shipments: [],
  });

  const option = model.brewTankOptions.find((item) => item.tankNumber === "2");
  assert.ok(option);
  assert.equal(option.availableDate, "2026-09-28");
  assert.equal(model.brewTankCapacity, 1);
});
