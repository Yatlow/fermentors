import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { dailyForecast, futureTanks } from "../src/SERVICES/planning/dailyPlanner";
import { simulatedGanttBrews } from "../src/SERVICES/planning/ganttBrewProjection";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";
import {
  completedShipmentQueueTruckId, matchActualShipments,
  pendingPlansAfterActualShipments, mergeCompletedDeliveriesBack,
} from "../src/SERVICES/planning/shipmentActuals";
import { auditShipmentAvailability } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { validatePlanningDecisionChange } from "../src/SERVICES/planning/planningDecisionSafety";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { selectTruck } from "../src/SERVICES/planning/truckPlanner";

const today = "2026-10-18";
const ipa: Product = {
  id: "ipa-crates", sku: "ipa-crates", style: "IPA",
  type: "crates", monthly: 300, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [ipa] };
const pallet: Pallet = {
  id: "still-here", itemType: "crates", beerStyle: "IPA", quantity: 84,
  zone: "cooler", expiryDateStr: "31/12/2026", heightUnits: 1,
};
const twoTrips = { ...emptyWeek("2026-10-18"), deliveries: [
  { id: "trip-a", truckId: "truck-a", productId: ipa.id,
    quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" },
  { id: "trip-b", truckId: "truck-b", productId: ipa.id,
    quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" },
]};
const oneActual = {
  id: "actual-a", date: "2026-10-19",
  totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 84 }],
};

test("one of two same-day dispatches leaves one real open trip", () => {
  const matches = matchActualShipments(twoTrips.deliveries, [oneActual], settings.products);
  assert.equal(matches.filter((match) => match.status === "pending").length, 1);
  assert.equal(matches.filter((match) => match.status === "matched").length, 1);
  const pending = pendingPlansAfterActualShipments([twoTrips], [oneActual], settings.products);
  assert.equal(pending[0]!.deliveries!.length, 1);
  assert.equal(pending[0]!.deliveries![0]!.truckId, "truck-b");
});

test("actual with an unrelated manifest cannot close a planned dispatch", () => {
  const unrelated = { ...oneActual, totals: [
    { itemType: "crates" as const, beerStyle: "חיטה", totalQuantity: 84 },
  ] };
  assert.equal(matchActualShipments(twoTrips.deliveries, [unrelated], settings.products)
    .filter((match) => match.status === "pending").length, 2);
  assert.equal(completedShipmentQueueTruckId(twoTrips.deliveries, { "unknown-sku": 84 },
    "2026-10-19"), null);
});

test("day forecast reserves stock for the second same-day trip after the first has left", () => {
  const result = dailyForecast(settings, [pallet], [], [twoTrips], [], today,
    [], false, [oneActual]);
  const after = result.points.find((point) =>
    point.date === "2026-10-19" && point.productId === ipa.id);
  assert.ok(after);
  assert.equal(after.brewery, 0, "still-open truck consumes the one remaining pallet");
  assert.equal(after.arrived, 84, "a completed truck is not projected as a second dispatch");
});

test("later weekly opening stock counts only unfulfilled same-day trips", () => {
  const row = buildWeekStartProjection({
    settings, pallets: [pallet], plans: [twoTrips], actuals: [],
    today, week: "2026-10-25", actualShipments: [oneActual],
  }).get(ipa.id);
  assert.equal(row?.shipmentsBeforeWeek, 84);
  assert.equal(row?.breweryUnits, 0);
  const issues = auditShipmentAvailability(settings, [pallet], [twoTrips], [],
    today, [oneActual]);
  assert.equal(issues.length, 0, "one still-open truck is covered by one remaining pallet");
});

test("weekly decision save rejects removing tank 4 release needed by an existing future brew", () => {
  const wheat: Product = { ...ipa, id: "wheat-kegs", sku: "wheat-kegs",
    style: "חיטה", type: "kegs", monthly: 240 };
  const wheatSettings = { ...defaultSettings(), products: [wheat] };
  const tank: Tank = {
    id: "tank-4", number: "4", batch: "1614", style: "חיטה",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const source = { id: tank.id, tankNumber: 4, batchNumber: tank.batch,
    brewDate: "12/10/2026", beerStyle: tank.style, action: 1 };
  const liveBrew = { ...emptyWeek("2026-10-11"), brews: [{
    id: "brew-live-wheat-4", tankId: tank.id, style: tank.style,
    date: "2026-10-12", batchNumber: tank.batch, liters: 1100,
  }] };
  const packed = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "wheat4-kegs", productId: wheat.id, quantity: 56,
    tankId: tank.id, tankNumber: "4", batchNumber: tank.batch,
    brewId: "brew-live-wheat-4", date: "2026-11-05",
  }] };
  const future = { ...emptyWeek("2026-11-08"), brews: [{
    id: "next-wheat", tankId: tank.id, style: tank.style,
    date: "2026-11-09", liters: 1100,
  }] };
  const before: WeekPlan[] = [liveBrew, packed, future];
  const edited = { ...packed, packaging: [{ ...packed.packaging[0], quantity: 55 }] };
  const after: WeekPlan[] = [liveBrew, edited, future];
  const err = validatePlanningDecisionChange({
    before, after, edited, previous: packed,
    settings: wheatSettings, tanks: [tank], sources: [source],
    actuals: [], today: "2026-10-22",
  });
  assert.ok(err, "editing week 45 must not silently invalidate committed week 46");
  assert.match(err, /מיכל|ריקון|בישול|מחזור/);
});

test("a metadata-only edit does not rewrite or revalidate historical completed brews", () => {
  const old = { ...emptyWeek("2026-10-18"), brews: [{
    id: "old", style: "IPA", tankId: "", date: "2026-10-19", liters: 1100,
  }] };
  const edited = { ...old, note: "Updated planner note" };
  assert.equal(validatePlanningDecisionChange({
    before: [old], after: [edited], edited, previous: old,
    settings, tanks: [], sources: [], actuals: [], today: "2026-10-23",
  }), null);
});

test("invalid weekly shipment quantities are blocked before Firestore save", () => {
  const bad = { ...twoTrips, deliveries: [{
    ...twoTrips.deliveries[0], quantity: -4,
  }] };
  assert.match(validatePlanningDecisionChange({
    before: [twoTrips], after: [bad], edited: bad, previous: twoTrips,
    settings, tanks: [], sources: [], actuals: [], today,
  }) ?? "", /משלוח|כמות/);
});

test("Gantt recommendation forecasts reserve specific tanks but remain hypothetical", () => {
  const projected = simulatedGanttBrews("2026-10-25", [
    { style: "IPA", liters: 3000, tankId: "tank-10", tankNumber: "10",
      sizeLabel: "משולש", availableDate: "2026-10-26" },
    { style: "IPA", liters: 3000, tankId: "tank-11", tankNumber: "11",
      sizeLabel: "משולש", availableDate: "2026-10-27" },
    { style: "IPA", liters: 3000, tankId: "tank-12", tankNumber: "12",
      sizeLabel: "משולש", availableDate: "2026-10-29" },
  ]);
  assert.equal(projected.length, 2, "no imaginary Thursday brewery shift");
  assert.deepEqual(projected.map((brew) => brew.date), ["2026-10-26", "2026-10-27"]);
  assert.deepEqual(projected.map((brew) => brew.tankId), ["tank-10", "tank-11"]);
  assert.ok(projected.every((brew) => brew.tankAssignmentStatus === "tentative"));
  const virtualTanks = futureTanks([], [{ ...emptyWeek("2026-10-25"), brews: projected }], settings);
  assert.ok(virtualTanks.some((tank) => tank.id === "planned:gantt-rec-brew:2026-10-25:0"));
  assert.ok(virtualTanks.some((tank) => tank.id === "planned:gantt-rec-brew:2026-10-25:1"));
});

test("one physical dispatch matches its best SKU trip even when another trip is listed first", () => {
  const another: Product = { ...ipa, id: "wheat-crates", sku: "wheat-crates", style: "חיטה" };
  const mixed = { ...twoTrips, deliveries: [
    { ...twoTrips.deliveries[0], productId: ipa.id },
    { ...twoTrips.deliveries[1], productId: another.id },
  ] };
  const actual = { ...oneActual, totals: [
    { itemType: "crates" as const, beerStyle: another.style, totalQuantity: 84 },
  ] };
  const matches = matchActualShipments(mixed.deliveries, [actual], [ipa, another]);
  assert.equal(matches.find((m) => m.planned.id === "truck-a")?.status, "pending");
  assert.equal(matches.find((m) => m.planned.id === "truck-b")?.status, "matched");
});

test("re-saving a full week cannot duplicate an already completed trip", () => {
  const merged = mergeCompletedDeliveriesBack(twoTrips, twoTrips, [oneActual], settings.products);
  assert.equal(merged.deliveries?.length, 2);
  assert.equal(merged.deliveries?.filter((d) => d.truckId === "truck-a").length, 1);
  assert.equal(merged.deliveries?.filter((d) => d.truckId === "truck-b").length, 1);
});

test("an unknown-SKU actual is not treated as an empty legacy manifest", () => {
  const unknown = { ...oneActual, totals: [
    { itemType: "crates" as const, beerStyle: "not-in-catalog", totalQuantity: 84 },
  ] };
  assert.ok(matchActualShipments([twoTrips.deliveries[0]], [unknown], settings.products)
    .every((m) => m.status === "pending"));
});


test("a canonical brew already in a physical tank contributes real packaging to the daily supply forecast", () => {
  const wheat: Product = { ...ipa, id: "wheat-kegs", sku: "wheat-kegs",
    style: "חיטה", type: "kegs", monthly: 300 };
  const wheatSettings = { ...defaultSettings(), products: [wheat] };
  const physical: Tank = {
    id: "tank-4", number: "4", style: "חיטה", batch: "1614",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const brewWeek = { ...emptyWeek("2026-10-11"), brews: [{
    id: "brew-wheat-1614", tankId: physical.id, style: physical.style,
    date: physical.brewed, batchNumber: physical.batch, liters: 1100,
  }] };
  const packWeek = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "pack-56", productId: wheat.id, quantity: 56, date: "2026-11-05",
    tankId: physical.id, batchNumber: physical.batch, brewId: "brew-wheat-1614",
  }] };
  const forecast = dailyForecast(wheatSettings, [], [physical], [brewWeek, packWeek],
    [], "2026-10-22");
  const packed = forecast.points.find((row) =>
    row.date === "2026-11-05" && row.productId === wheat.id);
  assert.ok(packed);
  assert.equal(packed.packed, 56);
  assert.ok(!forecast.warnings.some((warning) => warning.includes("חסרים") &&
    warning.includes("חיטה")), "the physical cycle is the canonical source, not a missing virtual tank");
});

test("recommended next IPA brew uses the IPA volume despite the tank's former Lager style", () => {
  const highDemand: Product = { ...ipa, monthly: 1000, tempo: 0,
    tempoDate: "2026-10-22" };
  const ipaSettings = { ...defaultSettings(), products: [highDemand] };
  const source = { id: "tank-6", tankNumber: 6, beerStyle: "לאגר", action: 4 };
  const model = buildWeeklyPlanningModel({
    settings: ipaSettings, pallets: [], tanks: [], plans: [], actuals: [],
    sources: [source], today: "2026-10-22", week: "2026-10-25",
    holidays: [], shipments: [],
  });
  const recommended = model.brewRecommendations.find((brew) =>
    brew.tankId === source.id && brew.style === "IPA");
  assert.ok(recommended, "free double tank must be available for IPA shortage");
  assert.equal(recommended.liters, 1960, "not the former Lager cycle's 2500 liters");
});

test("forecast FEFO prevails over production-date FIFO when expiry dates disagree", () => {
  const oldProduction = { ...pallet, id: "old-production",
    batchNumber: "older", expiryDateStr: "31/12/2026" };
  const soonToExpire = { ...pallet, id: "earlier-expiry",
    batchNumber: "newer", expiryDateStr: "31/10/2026" };
  const picked = selectTruck([ipa], [
    { pallet: oldProduction, quantity: 84, expiry: "2026-12-31" },
    { pallet: soonToExpire, quantity: 84, expiry: "2026-10-31" },
  ], new Map([[ipa.id, 84]]), new Map([[ipa.id, 1]]),
  new Map([["older:" + ipa.id, "2026-01-01"], ["newer:" + ipa.id, "2026-09-01"]]));
  assert.equal(picked.pallets[0]?.id, "earlier-expiry");
});

