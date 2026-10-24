import { test } from "node:test";
import assert from "node:assert/strict";
import { addForecastPackaging, dispatchForecastPallets, type ForecastPalletLot } from
  "../src/SERVICES/planning/shipmentPalletLedger";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";
import { auditShipmentAvailability } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { dailyForecast } from "../src/SERVICES/planning/dailyPlanner";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";

const today = "2026-10-18";
const product: Product = {
  id: "ipa-crates", sku: "ipa-crates", type: "crates", style: "IPA",
  tempo: 0, tempoDate: today, monthly: 360, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [product] };

function pallet(id: string, quantity: number, expiryDateStr = "31/12/2026"): Pallet {
  return { id, beerStyle: "IPA", itemType: "crates", zone: "cooler",
    expiryDateStr, quantity, heightUnits: 1 };
}
function shipment(quantity: number) {
  return { ...emptyWeek("2026-10-18"), deliveries: [{
    id: "trip", truckId: "truck-1", productId: product.id,
    dispatchDate: "2026-10-19", arrivalDate: "2026-10-19", quantity,
  }] };
}

test("a partial 42-crate pallet is not split or reused as a fraction by two trucks", () => {
  const lots: ForecastPalletLot[] = [
    { id: "a", expiry: "2026-12-31", quantity: 42 },
    { id: "b", expiry: "2026-12-31", quantity: 42 },
  ];
  const first = dispatchForecastPallets(lots, 84, 84, "2026-10-19");
  assert.deepEqual({ missingSlots: first.missingSlots, missingUnits: first.missingUnits },
    { missingSlots: 0, missingUnits: 42 });
  assert.equal(lots.length, 1, "one physical partial pallet remains, not a 42-unit fraction");
  assert.equal(lots[0].quantity, 42);
  const second = dispatchForecastPallets(lots, 42, 84, "2026-10-20");
  assert.equal(second.missingSlots, 0);
  assert.equal(second.missingUnits, 0);
  assert.equal(lots.length, 0);
});

test("one 100-crate future packaging produces one full and one 16-crate provisional pallet", () => {
  const lots: ForecastPalletLot[] = [];
  addForecastPackaging(lots, 100, 84, "future-week42");
  assert.deepEqual(lots.map((lot) => lot.quantity), [84, 16]);
  assert.ok(lots.every((lot) => lot.provisional && lot.expiry === "9999-12-31"));
  const dispatched = dispatchForecastPallets(lots, 84, 84, "2026-10-22");
  assert.equal(dispatched.missingUnits, 0);
  assert.equal(dispatched.provisionalPallets, 1);
  assert.deepEqual(lots.map((lot) => lot.quantity), [16]);
});

test("FEFO expires the old pallet without deleting the newer valid lot", () => {
  const lots: ForecastPalletLot[] = [
    { id: "old", quantity: 84, expiry: "2026-10-19" },
    { id: "new", quantity: 84, expiry: "2026-11-19" },
  ];
  const result = dispatchForecastPallets(lots, 84, 84, "2026-10-20");
  assert.equal(result.missingUnits, 0);
  assert.equal(lots.length, 0, "old expired, new pallet dispatched");
});

test("the weekly stock and availability audits agree on two partial pallets", () => {
  const pallets = [pallet("a", 42), pallet("b", 42)];
  const plans = [shipment(84)];
  const issues = auditShipmentAvailability(settings, pallets, plans, [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].missing, 0);
  assert.equal(issues[0].missingUnits, 42);
  assert.equal(issues[0].severity, "partial");
  const opening = buildWeekStartProjection({
    settings, pallets, plans, actuals: [], today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(opening?.breweryUnits, 42, "the second partial pallet remains physical stock");
});

test("a fully stocked loading pallet is never reused after an earlier shipment", () => {
  const plans = [shipment(84), {
    ...emptyWeek("2026-10-25"), deliveries: [{
      id: "later", truckId: "truck-later", productId: product.id,
      quantity: 84, dispatchDate: "2026-10-26", arrivalDate: "2026-10-26",
    }],
  }];
  const issues = auditShipmentAvailability(settings, [pallet("one", 84)], plans, [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].week, "2026-10-25");
  assert.equal(issues[0].missing, 1);
});

test("the daily forecast agrees with week opening and physical partial-pallet shortage", () => {
  const pallets = [pallet("a", 42), pallet("b", 42)];
  const plans = [shipment(84)];
  const forecast = dailyForecast(settings, pallets, [], plans, [], today);
  const departure = forecast.points.find((point) =>
    point.productId === product.id && point.date === "2026-10-19");
  assert.ok(departure);
  assert.equal(departure.brewery, 42,
    "the second partial pallet stays in physical inventory");
  assert.equal(departure.arrived, 42,
    "only the actual first partial pallet quantity reaches Tempo in the forecast");
  assert.ok(forecast.warnings.some((warning) => warning.includes("42 יחידות")),
    "physical shipping shortfall is surfaced to the planner");
});

test("Tempo opening balance credits only 30 physically shippable crates, not 84 planned", () => {
  const physical = [pallet("partial", 30)];
  const planned = [shipment(84)];
  const issue = auditShipmentAvailability(settings, physical, planned, [], today);
  assert.equal(issue[0].missingUnits, 54);
  const weekOpening = buildWeekStartProjection({
    settings, pallets: physical, plans: planned, actuals: [],
    today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(weekOpening?.shipmentsBeforeWeek, 84, "retain nominal planned units for review");
  assert.equal(weekOpening?.breweryUnits, 0);
  assert.equal(weekOpening?.tempoUnits, 30,
    "the future Tempo balance must never invent the 54 missing physical crates");
  const daily = dailyForecast(settings, physical, [], planned, [], today);
  assert.equal(daily.points.find((p) => p.date === "2026-10-19")?.arrived, 30);
});

test("shipment physically dispatched but arriving next week is not in this week's opening Tempo", () => {
  const delayed = { ...shipment(84), deliveries: [{
    ...shipment(84).deliveries[0], arrivalDate: "2026-10-28",
  }] };
  const opening = buildWeekStartProjection({
    settings, pallets: [pallet("full", 84)], plans: [delayed],
    actuals: [], today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(opening?.breweryUnits, 0, "the pallet already left the brewery");
  assert.equal(opening?.tempoUnits, 0, "the truck has not reached Tempo yet");
  const next = buildWeekStartProjection({
    settings, pallets: [pallet("full", 84)], plans: [delayed],
    actuals: [], today, week: "2026-11-01",
  }).get(product.id);
  assert.equal(next?.tempoUnits, 84, "arriving pallets appear only after physical arrival");
});
