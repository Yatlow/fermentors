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
import { projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";
import { dailyForecast, futureTanks } from "../src/SERVICES/planning/dailyPlanner";
import {
  brewLitersForSize,
  brewSizeLabel,
  normalizeEmptyTankFlagsForSchedule,
  tankReleases,
  validateProduction,
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

test("committed early packaging still releases a tank for the following brewing week", () => {
  const tank: Tank = {
    id: "tank-early",
    number: "4",
    batch: "early-batch",
    style: "IPA",
    brewed: "2026-09-01",
    ready: "2026-09-24",
    liters: 1000,
    cold: true,
  };
  const plan = {
    ...emptyWeek("2026-09-20"),
    packaging: [{
      id: "early-pack",
      productId: product.id,
      quantity: 126,
      date: "2026-09-22",
      tankId: tank.id,
      tankNumber: tank.number,
      emptyTank: true,
    }],
  };

  const releases = tankReleases(
    [{ id: tank.id, tankNumber: 4, beerStyle: "IPA", beerVolume: 1100, tankStatus: false, action: 1 }],
    [tank],
    [plan],
    settings,
    [],
    today,
  );

  assert.equal(releases[0].emptyDate, "2026-09-22");
  assert.equal(releases[0].date, "2026-09-28");
});

test("committed early packaging contributes finished stock to the forecast", () => {
  const tank: Tank = {
    id: "tank-forecast-early",
    number: "4",
    batch: "forecast-early",
    style: "IPA",
    brewed: "2026-09-01",
    ready: "2026-09-24",
    liters: 1000,
    cold: true,
  };
  const plan = {
    ...emptyWeek("2026-09-20"),
    packaging: [{
      id: "early-stock",
      productId: product.id,
      quantity: 84,
      date: "2026-09-22",
      tankId: tank.id,
      tankNumber: tank.number,
    }],
  };

  const forecast = dailyForecast(settings, [], [tank], [plan], [], today);
  const point = forecast.points.find((row) => row.date === "2026-09-22" && row.productId === product.id);
  assert.equal(point?.packed, 84);
});

test("saved early packaging approval avoids repeated readiness confirmation", () => {
  const tank: Tank = {
    id: "tank-approved-early",
    number: "4",
    batch: "approved-early",
    style: "IPA",
    brewed: "2026-09-01",
    ready: "2026-09-24",
    liters: 1000,
    cold: true,
  };
  const plan = {
    ...emptyWeek("2026-09-20"),
    packaging: [{
      id: "approved-early-pack",
      productId: product.id,
      quantity: 84,
      date: "2026-09-22",
      tankId: tank.id,
      tankNumber: tank.number,
      earlyPackagingOverride: true,
    }],
  };

  assert.equal(validateProduction([plan], settings, [tank], [], today), null);
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


test("prior-week canonical packaging carries finished stock into the following week forecast", () => {
  const localSettings = { ...settings, products: [product] };
  const brewId = "future-wheat-cycle";
  const tank: Tank = {
    id: "tank-11",
    number: "11",
    batch: "old-cycle",
    style: "IPA",
    brewed: "2026-08-01",
    ready: "2026-08-25",
    liters: 1000,
    cold: true,
  };
  const prior = {
    ...emptyWeek("2026-09-20"),
    brews: [{
      id: brewId,
      style: "IPA",
      tankId: tank.id,
      batchNumber: "1601",
      date: "2026-09-21",
      liters: 1100,
    }],
    packaging: [{
      id: "canonical-pack",
      productId: product.id,
      quantity: 84,
      tankId: tank.id,
      tankNumber: tank.number,
      batchNumber: "1601",
      brewId,
      date: "2026-09-24",
    }],
  };

  const forecast = dailyForecast(localSettings, [], [tank], [prior], [], today);
  const packed = forecast.points.find((row) => row.date === "2026-09-24" && row.productId === product.id);
  const followingWeek = forecast.points.find((row) => row.date === "2026-09-27" && row.productId === product.id);
  assert.equal(packed?.packed, 84);
  assert.ok((followingWeek?.brewery ?? 0) > 0, "packaged stock must remain in brewery inventory next week");
});


test("special beer without inventory SKU can empty and release a tank", () => {
  const tank: Tank = {
    id: "tank-special",
    number: "6",
    batch: "winter-1",
    style: "מהדורת חורף",
    brewed: "2026-09-01",
    ready: "2026-09-20",
    liters: 1000,
    cold: true,
  };
  const plan = {
    ...emptyWeek("2026-09-13"),
    packaging: [{
      id: "winter-pack",
      productId: "",
      nonInventoryStyle: "מהדורת חורף",
      nonInventoryType: "kegs" as const,
      quantity: 50,
      date: "2026-09-20",
      tankId: tank.id,
      tankNumber: tank.number,
      emptyTank: true,
    }],
  };
  const localSettings = { ...settings, products: [product, kegProduct] };

  assert.equal(validateProduction([plan], localSettings, [tank], [], today), null);
  const releases = tankReleases(
    [{ id: tank.id, tankNumber: 6, beerStyle: "מהדורת חורף", beerVolume: 1000, tankStatus: false, action: 1 }],
    [tank],
    [plan],
    localSettings,
    [],
    today,
  );
  assert.equal(releases[0].emptyDate, "2026-09-20");
  assert.equal(releases[0].remaining, 0);
});


test("planned tank cycle keeps canonical net volume without applying shrinkage twice", () => {
  const physical: Tank = {
    id: "tank-11",
    number: "11",
    batch: "old",
    style: "IPA",
    brewed: "2026-08-01",
    ready: "2026-08-22",
    liters: 500,
    cold: true,
  };
  const plan = {
    ...emptyWeek("2026-10-04"),
    brews: [{
      id: "ipa-triple-cycle",
      style: "IPA",
      tankId: physical.id,
      batchNumber: "1700",
      date: "2026-10-05",
      liters: brewLitersForSize("IPA", "משולש"),
    }],
  };

  const projected = futureTanks([physical], [plan], settings);
  const future = projected.find((tank) => tank.id === "planned:ipa-triple-cycle");
  assert.ok(future);
  assert.equal(future.liters, 3000, "3000 L fallback is already net packaging volume");
});


const week46Today = "2026-10-22";
const week45 = "2026-11-01";
const week46 = "2026-11-08";

test("week 46 stout drain combines same-tank same-SKU parts into one day", () => {
  const stout: Product = {
    ...product, id: "stout-crates", sku: "stout-crates", style: "סטאוט",
    type: "crates", monthly: 42, tempo: 0, tempoDate: week46Today,
  };
  const tank: Tank = {
    id: "tank-3", number: "3", batch: "S3", style: "סטאוט",
    brewed: "2026-09-01", ready: "2026-10-01", liters: 1093, cold: true,
  };
  const model = buildWeeklyPlanningModel({
    settings: { ...settings, products: [stout] },
    pallets: [], tanks: [tank], plans: [], actuals: [],
    sources: [{ id: tank.id, tankNumber: 3, batchNumber: tank.batch,
      brewDate: "01/09/2026", beerStyle: tank.style, action: 1 }],
    today: week46Today, week: week46, holidays: [], shipments: [],
  });
  const runs = model.packagingRecommendation.filter((run) => run.tankNumber === "3");
  assert.equal(runs.length, 1, "one SKU on one tank must have a single recommendation");
  assert.equal(runs[0].quantity, 138);
  assert.equal(model.packagingDays, 1, "138 crates fit in one 252-crate production day");
});

test("week 45 IPA 11 near-complete packaging releases it for week 46", () => {
  const crate: Product = { ...product, monthly: 50, tempo: 20000, tempoDate: week46Today };
  const keg: Product = { ...crate, id: "ipa-kegs", sku: "ipa-kegs", type: "kegs" };
  const localSettings = { ...settings, products: [crate, keg] };
  const tank: Tank = {
    id: "tank-11", number: "11", batch: "B11", style: "IPA",
    brewed: "2026-10-01", ready: "2026-10-22", liters: 3000, cold: true,
  };
  const source = {
    id: tank.id, tankNumber: 11, batchNumber: "B11", brewDate: "01/10/2026",
    beerStyle: "IPA", action: 1, beerVolume: 3333,
  };
  const prior = {
    ...emptyWeek(week45),
    packaging: [
      { id: "11-crates", productId: crate.id, quantity: 252,
        tankId: tank.id, tankNumber: tank.number, batchNumber: tank.batch, date: "2026-11-05" },
      { id: "11-kegs", productId: keg.id, quantity: 50,
        tankId: tank.id, tankNumber: tank.number, batchNumber: tank.batch, date: "2026-11-05" },
    ],
  };
  const release = tankReleases([source], [tank], [prior], localSettings, [], week46Today)[0];
  assert.equal(release.emptyDate, "2026-11-05");
  assert.equal(release.date, "2026-11-09");
  const model = buildWeeklyPlanningModel({
    settings: localSettings, pallets: [], tanks: [tank], plans: [prior],
    actuals: [], sources: [source], today: week46Today, week: week46,
    holidays: [], shipments: [],
  });
  assert.ok(model.brewTankOptions.some((option) => option.tankNumber === "11"),
    "tank 11 must be available for week 46, not kept occupied by a 4 L heel");
});

test("week 46 finishes Pale 14 despite sufficient stock cover, then releases week 47", () => {
  const pale: Product = {
    ...product, id: "pale-crates", sku: "pale-crates",
    style: "פייל אייל", monthly: 50, tempo: 20000, tempoDate: week46Today,
  };
  const localSettings = { ...settings, products: [pale] };
  const tank: Tank = {
    id: "tank-14", number: "14", batch: "P14", style: pale.style,
    brewed: "2026-10-01", ready: "2026-10-22", liters: 3200, cold: true,
  };
  const source = {
    id: tank.id, tankNumber: 14, batchNumber: tank.batch,
    brewDate: "01/10/2026", beerStyle: tank.style, action: 1,
  };
  const prior = {
    ...emptyWeek(week45),
    packaging: [{ id: "pale-14-first", productId: pale.id, quantity: 252,
      tankId: tank.id, tankNumber: tank.number, batchNumber: tank.batch, date: "2026-11-05" }],
  };
  assert.equal(tankReleases([source], [tank], [prior], localSettings, [], week46Today)[0].date, null,
    "a partially emptied tank must not become brew-ready");
  const model = buildWeeklyPlanningModel({
    settings: localSettings, pallets: [], tanks: [tank], plans: [prior],
    actuals: [], sources: [source], today: week46Today, week: week46,
    holidays: [], shipments: [],
  });
  const finish = model.packagingRecommendation.filter((run) => run.tankNumber === "14");
  assert.equal(finish.length, 1);
  assert.equal(finish[0].quantity, 152, "remaining 1204 L is 152 crates");
  assert.equal(model.packagingDays, 1);
  assert.ok(!model.brewTankOptions.some((option) => option.tankNumber === "14"),
    "tank 14 must not be reused in week 46 before its finishing pack");
  const completed = { ...emptyWeek(week46), packaging: [{
    id: "pale-14-final", productId: pale.id, quantity: finish[0].quantity,
    tankId: tank.id, tankNumber: tank.number, batchNumber: tank.batch,
    date: "2026-11-12", emptyTank: true,
  }] };
  const after = tankReleases([source], [tank], [prior, completed], localSettings, [], week46Today)[0];
  assert.equal(after.emptyDate, "2026-11-12");
  assert.equal(after.date, "2026-11-16", "Thursday finish releases on following Monday");
});

test("canonical cycles infer near-empty release, not a partial or overallocated run", () => {
  const localSettings = { ...settings, products: [product, kegProduct] };
  const brewWeek = { ...emptyWeek("2026-10-25"), brews: [{
    id: "ipa11-cycle", tankId: "tank-11", style: "IPA",
    date: "2026-10-26", liters: 3000, batchNumber: "B11",
  }] };
  const crates = {
    id: "c11", brewId: "ipa11-cycle", productId: product.id,
    quantity: 252, tankId: "tank-11", date: "2026-11-05",
  };
  const kegs = { ...crates, id: "k11", productId: kegProduct.id, quantity: 50 };
  const projected = projectTankSchedules([brewWeek, {
    ...emptyWeek(week45), packaging: [crates, kegs],
  }], localSettings, week46Today).get("tank-11")!;
  assert.equal(projected[0].emptyDate, "2026-11-05");
  const partial = projectTankSchedules([brewWeek, {
    ...emptyWeek(week45), packaging: [crates],
  }], localSettings, week46Today).get("tank-11")!;
  assert.equal(partial[0].emptyDate, undefined);
  const invalid = projectTankSchedules([brewWeek, {
    ...emptyWeek(week45), packaging: [{ ...crates, quantity: 400 }],
  }], localSettings, week46Today).get("tank-11")!;
  assert.equal(invalid[0].emptyDate, undefined);
  const expired = projectTankSchedules([brewWeek, {
    ...emptyWeek(week45), packaging: [crates, kegs],
  }], localSettings, week46).get("tank-11")!;
  assert.equal(expired[0].emptyDate, undefined,
    "an overdue plan alone cannot certify an already completed emptying");
});

test("week 46 proposals reconcile a physical batch after stale forecast renumbering", () => {
  const pale: Product = { ...product, id: "pale-kegs", sku: "pale-kegs",
    style: "פייל אייל", type: "kegs", monthly: 50, tempo: 20000, tempoDate: week46Today };
  const localSettings = { ...settings, products: [pale] };
  const tank: Tank = {
    id: "tank-14", number: "14", batch: "live-14", style: pale.style,
    brewed: "2026-10-01", ready: "2026-10-22", liters: 1190, cold: true,
  };
  const source = {
    id: tank.id, tankNumber: 14, batchNumber: "live-14", brewDate: "01/10/2026",
    beerStyle: pale.style, action: 1,
  };
  const forecast = { ...emptyWeek("2026-09-27"), brews: [{
    id: "stale-planned-14", tankId: tank.id, style: pale.style,
    date: "2026-10-01", liters: 3200, batchNumber: "old-forecast-14",
  }] };
  const packed = { ...emptyWeek(week45), packaging: [{
    id: "physical-empty-14", productId: pale.id, quantity: 59,
    tankId: tank.id, tankNumber: tank.number, batchNumber: tank.batch,
    date: "2026-11-05", emptyTank: true,
  }] };
  const model = buildWeeklyPlanningModel({
    settings: localSettings, pallets: [], tanks: [tank], plans: [forecast, packed],
    actuals: [], sources: [source], today: week46Today, week: week46,
    holidays: [], shipments: [],
  });
  assert.ok(model.brewTankOptions.some((option) => option.tankNumber === "14"),
    "confirmed live-batch emptying should overcome stale forecast batch identity");
});

test("overdue unperformed week 45 packaging cannot fake a week 46 finishing pack", () => {
  const pale: Product = {
    ...product, id: "pale-crates", sku: "pale-crates",
    style: "פייל אייל", monthly: 50, tempo: 20000, tempoDate: week46Today,
  };
  const tank: Tank = {
    id: "tank-14", number: "14", batch: "live-14", style: pale.style,
    brewed: "2026-10-01", ready: "2026-10-22", liters: 3200, cold: true,
  };
  const source = { id: tank.id, tankNumber: 14, batchNumber: tank.batch,
    brewDate: "01/10/2026", beerStyle: pale.style, action: 1 };
  const prior = { ...emptyWeek(week45), packaging: [{
    id: "overdue-but-unperformed", productId: pale.id, quantity: 252,
    tankId: tank.id, tankNumber: tank.number, batchNumber: tank.batch, date: "2026-11-05",
  }] };
  const model = buildWeeklyPlanningModel({
    settings: { ...settings, products: [pale] },
    pallets: [], tanks: [tank], plans: [prior], actuals: [],
    sources: [source], today: "2026-11-06", week: week46,
    holidays: [], shipments: [],
  });
  assert.equal(model.packagingRecommendation.length, 0,
    "no previous actual packaging: do not recommend only a phantom remainder");
  assert.ok(!model.brewTankOptions.some((option) => option.tankNumber === "14"),
    "an overdue plan alone must not free tank 14");
});


test("tank 4: 56 Wheat kegs in week 45 empty the physical 1120 L cycle and free week 46", () => {
  const wheatKegs: Product = {
    ...product, id: "wheat-kegs", sku: "wheat-kegs", style: "חיטה",
    type: "kegs", monthly: 240, tempo: 0, tempoDate: "2026-10-22",
  };
  const localSettings = { ...settings, products: [wheatKegs] };
  const tank: Tank = {
    id: "tank-4", number: "4", style: "חיטה", batch: "1614",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const source = {
    id: tank.id, tankNumber: 4, batchNumber: tank.batch,
    brewDate: "12/10/2026", beerStyle: tank.style, action: 1,
  };
  const brewWeek = { ...emptyWeek("2026-10-11"), brews: [{
    id: "brew-live-wheat-4", tankId: tank.id, style: "חיטה",
    date: "2026-10-12", batchNumber: tank.batch, liters: 1100,
  }] };
  const packedWeek45 = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "wheat4-56-kegs", productId: wheatKegs.id, quantity: 56,
    tankId: tank.id, tankNumber: "4", batchNumber: tank.batch,
    brewId: "brew-live-wheat-4", date: "2026-11-05",
    // Legacy decisions may not carry an explicit emptyTank marker.
  }] };
  const plans = [brewWeek, packedWeek45];
  const release = tankReleases([source], [tank], plans, localSettings, [], "2026-10-22")[0];
  assert.equal(release.emptyDate, "2026-11-05");
  assert.equal(release.date, "2026-11-09");

  const model = buildWeeklyPlanningModel({
    settings: localSettings, pallets: [], tanks: [tank], plans,
    actuals: [], sources: [source], today: "2026-10-22",
    week: "2026-11-08", holidays: [], shipments: [],
  });
  assert.equal(model.tankAvailableLiters.get("tank-4"), 0,
    "week 45 canonical packing must deplete the current physical tank exactly once");
  assert.ok(!model.packagingRecommendation.some((item) => item.tankNumber === "4"),
    "week 46 must not propose another 56 Wheat kegs");
  assert.ok(model.brewTankOptions.some((option) => option.tankNumber === "4" &&
    option.availableDate === "2026-11-09"),
    "tank 4 must become available Monday of week 46");
});

test("tank 4: 55 Wheat kegs leave a 20 L heel and must not free the tank", () => {
  const wheatKegs: Product = {
    ...product, id: "wheat-kegs", sku: "wheat-kegs", style: "חיטה",
    type: "kegs", monthly: 240, tempo: 0, tempoDate: "2026-10-22",
  };
  const localSettings = { ...settings, products: [wheatKegs] };
  const tank: Tank = {
    id: "tank-4", number: "4", style: "חיטה", batch: "1614",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const source = { id: tank.id, tankNumber: 4, batchNumber: tank.batch,
    brewDate: "12/10/2026", beerStyle: tank.style, action: 1 };
  const brewWeek = { ...emptyWeek("2026-10-11"), brews: [{
    id: "brew-live-wheat-4", tankId: tank.id, style: "חיטה",
    date: "2026-10-12", batchNumber: tank.batch, liters: 1100,
  }] };
  const pack = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "partial-wheat4-55", productId: wheatKegs.id, quantity: 55,
    tankId: tank.id, tankNumber: "4", batchNumber: tank.batch,
    brewId: "brew-live-wheat-4", date: "2026-11-05",
  }] };
  const plans = [brewWeek, pack];
  assert.equal(tankReleases([source], [tank], plans, localSettings, [], "2026-10-22")[0].date, null,
    "a whole keg remaining must not be treated as an empty tank");
  const model = buildWeeklyPlanningModel({
    settings: localSettings, pallets: [], tanks: [tank], plans,
    actuals: [], sources: [source], today: "2026-10-22",
    week: "2026-11-08", holidays: [], shipments: [],
  });
  assert.equal(model.tankAvailableLiters.get("tank-4"), 20);
  assert.ok(!model.brewTankOptions.some((option) => option.tankNumber === "4"));
  assert.deepEqual(model.packagingRecommendation.filter((item) => item.tankNumber === "4")
    .map((item) => item.quantity), [1], "one final keg should be recommended in week 46");
});

test("packaging on another canonical batch never drains current physical tank 4", () => {
  const wheatKegs: Product = {
    ...product, id: "wheat-kegs", sku: "wheat-kegs", style: "חיטה",
    type: "kegs", monthly: 240, tempo: 0, tempoDate: "2026-10-22",
  };
  const tank: Tank = {
    id: "tank-4", number: "4", style: "חיטה", batch: "1614",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const source = { id: tank.id, tankNumber: 4, batchNumber: tank.batch,
    brewDate: "12/10/2026", beerStyle: tank.style, action: 1 };
  const localSettings = { ...settings, products: [wheatKegs] };
  const brewWeek = { ...emptyWeek("2026-10-11"), brews: [{
    id: "other-wheat-4", tankId: tank.id, style: "חיטה",
    date: "2026-10-13", batchNumber: "1615", liters: 1100,
  }] };
  const packedWeek45 = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "other-56", productId: wheatKegs.id, quantity: 56,
    tankId: tank.id, tankNumber: "4", batchNumber: "1615",
    brewId: "other-wheat-4", date: "2026-11-05",
  }] };
  const model = buildWeeklyPlanningModel({
    settings: localSettings, pallets: [], tanks: [tank],
    plans: [brewWeek, packedWeek45], actuals: [], sources: [source],
    today: "2026-10-22", week: "2026-11-08",
    holidays: [], shipments: [],
  });
  assert.equal(model.tankAvailableLiters.get("tank-4"), 1120,
    "a future or different batch's packaging cannot deplete the live physical cycle");
  assert.equal(tankReleases([source], [tank], [brewWeek, packedWeek45], localSettings, [], "2026-10-22")[0].date, null);
});
