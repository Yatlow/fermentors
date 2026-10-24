import { test } from "node:test";
import assert from "node:assert/strict";
import { addForecastPackaging, dispatchForecastPallets, MAX_FEFO_SUBSET_STATES, reservedPhysicalPalletIds, type ForecastPalletLot } from
  "../src/SERVICES/planning/shipmentPalletLedger";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";
import { auditShipmentAvailability } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { dailyForecast } from "../src/SERVICES/planning/dailyPlanner";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../src/SERVICES/cooler/truckCapacity";
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

test("physical truck allows multiple low pallets within the 190cm height envelope", () => {
  assert.equal(calcTruckSlots([pallet("low-1", 12), pallet("low-2", 12)]), 1);
  assert.equal(calcTruckSlots([
    pallet("low-1", 12), pallet("low-2", 12), pallet("low-3", 12),
  ]), 1, "three 39cm pallets fit safely by height and occupy one floor place");
  assert.equal(calcTruckSlots(Array.from({ length: 24 }, (_, i) => pallet(`low-${i}`, 12))), 6);
  assert.equal(calcTruckSlots(Array.from({ length: 48 }, (_, i) => pallet(`low-${i}`, 12))), 12);
  assert.equal(calcTruckSlots(Array.from({ length: 49 }, (_, i) => pallet(`low-${i}`, 12))), 13);
});

test("shipment availability detects real overflow at 49 short pallets, not at 25", () => {
  const physical = Array.from({ length: 49 }, (_, i) => pallet(`low-${i}`, 12));
  const plan = shipment(588);
  const issues = auditShipmentAvailability(settings, physical, [plan], [], today);
  assert.ok(issues.some((issue) => issue.productId === "truck:truck-1" &&
    issue.severity === "blocking" && issue.missing === 1),
  "truck needs 13 physical floor places even when all pallets are only 39cm tall");
  assert.equal(calcTruckSlots(physical), MAX_TRUCK_SLOTS + 1);
});

test("two 42-crate pallets both ship for an 84-crate manifest and cannot ship twice", () => {
  const lots: ForecastPalletLot[] = [
    { id: "a", expiry: "2026-12-31", quantity: 42 },
    { id: "b", expiry: "2026-12-31", quantity: 42 },
  ];
  const first = dispatchForecastPallets(lots, 84, 84, "2026-10-19");
  assert.deepEqual({ missingSlots: first.missingSlots, missingUnits: first.missingUnits },
    { missingSlots: 0, missingUnits: 0 });
  assert.equal(first.shippedPhysical, 84, "both actual half-pallets ship, using two physical positions");
  assert.equal(lots.length, 0, "neither physical pallet can be reused");
  const second = dispatchForecastPallets(lots, 42, 84, "2026-10-20");
  assert.equal(second.missingSlots, 1);
  assert.equal(second.missingUnits, 42);
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

test("the weekly stock and availability audits agree that two partial pallets cover 84 units", () => {
  const pallets = [pallet("a", 42), pallet("b", 42)];
  const plans = [shipment(84)];
  const issues = auditShipmentAvailability(settings, pallets, plans, [], today);
  assert.equal(issues.length, 0, "two 42-crate physical pallets can fulfill 84 crates");
  const opening = buildWeekStartProjection({
    settings, pallets, plans, actuals: [], today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(opening?.breweryUnits, 0, "both physical pallets leave the brewery");
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

test("daily and weekly forecasts use both partial pallets rather than fabricating shortage", () => {
  const pallets = [pallet("a", 42), pallet("b", 42)];
  const plans = [shipment(84)];
  const forecast = dailyForecast(settings, pallets, [], plans, [], today);
  const departure = forecast.points.find((point) =>
    point.productId === product.id && point.date === "2026-10-19");
  assert.ok(departure);
  assert.equal(departure.brewery, 0, "both partial pallets leave");
  assert.equal(departure.arrived, 84, "the full 84 physical crates reach Tempo");
  assert.ok(!forecast.warnings.some((warning) => warning.includes("42 יחידות")));
});

test("one 42-crate partial pallet still gives a visible 42-unit advisory", () => {
  const stock = [pallet("only", 42)];
  const issues = auditShipmentAvailability(settings, stock, [shipment(84)], [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "partial");
  assert.equal(issues[0].missingUnits, 42);
});

test("three partial pallets never overdispatch 90 units for an 84-unit plan", () => {
  const lots: ForecastPalletLot[] = [
    { id: "a", expiry: "2026-10-26", quantity: 30 },
    { id: "b", expiry: "2026-10-27", quantity: 30 },
    { id: "c", expiry: "2026-10-28", quantity: 30 },
  ];
  const first = dispatchForecastPallets(lots, 84, 84, "2026-10-19");
  assert.equal(first.shippedPhysical, 60, "never ship a third entire pallet above the planned 84");
  assert.equal(first.missingUnits, 24);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].quantity, 30, "unshipped physical inventory is conserved");
  const next = dispatchForecastPallets(lots, 84, 84, "2026-10-20");
  assert.equal(next.shippedPhysical, 30);
  assert.equal(next.missingUnits, 54);
});

test("FEFO cannot silently consume a later 84-crate pallet on top of an earlier 42", () => {
  const lots: ForecastPalletLot[] = [
    { id: "older-half", expiry: "2026-10-26", quantity: 42 },
    { id: "later-full", expiry: "2026-11-26", quantity: 84 },
  ];
  const first = dispatchForecastPallets(lots, 84, 84, "2026-10-19");
  assert.equal(first.shippedPhysical, 42);
  assert.equal(first.missingUnits, 42);
  assert.deepEqual(lots.map((lot) => lot.id), ["later-full"],
    "a larger whole pallet is not silently loaded as an unrecorded over-delivery");
  const second = dispatchForecastPallets(lots, 84, 84, "2026-10-20");
  assert.equal(second.shippedPhysical, 84);
  assert.equal(second.missingUnits, 0);
});

test("same expiry subset chooses 50+34 instead of greedy 60 out of 84", () => {
  const lots: ForecastPalletLot[] = [
    { id: "large", expiry: "2026-11-26", quantity: 60 },
    { id: "medium", expiry: "2026-11-26", quantity: 50 },
    { id: "small", expiry: "2026-11-26", quantity: 34 },
  ];
  const shipment = dispatchForecastPallets(lots, 84, 84, "2026-10-19");
  assert.equal(shipment.shippedPhysical, 84);
  assert.deepEqual(shipment.selectedLots.map((lot) => lot.id), ["medium", "small"]);
  assert.deepEqual(lots.map((lot) => lot.id), ["large"]);
});

test("twelve nominal slots made from twenty-four half pallets MUST flag truck overload", () => {
  const physical = Array.from({ length: 24 }, (_, index) =>
    pallet(`half-${index}`, 42));
  const plan = shipment(12 * 84);
  const issues = auditShipmentAvailability(settings, physical, [plan], [], today);
  assert.equal(issues.filter((issue) => issue.missingUnits && issue.missingUnits > 0).length, 0,
    "all planned crate units physically exist");
  const overload = issues.find((issue) => issue.productId.startsWith("truck:"));
  assert.ok(overload, "physical pallet footprints must be validated beyond nominal capacity");
  assert.equal(overload.severity, "blocking");
  assert.equal(overload.missing, 12,
    "42-crate pallets are 111cm tall; 24 cannot stack within 12 floor positions");
});

test("FEFO replacement stock never masks an expired explicitly pinned dispatch pallet", () => {
  const old = pallet("pinned-expired", 84, "19/10/2026");
  const substitute = pallet("valid-not-assigned", 84, "31/12/2026");
  const plan = { ...shipment(84), deliveries: [{
    ...shipment(84).deliveries[0], dispatchDate: "2026-10-20",
    arrivalDate: "2026-10-20", pallets: [old],
  }] };
  const issues = auditShipmentAvailability(settings, [old, substitute],
    [plan], [], today);
  assert.ok(issues.some((issue) =>
    issue.productId === "pallet:pinned-expired" && issue.severity === "blocking"),
  "a different valid FEFO pallet cannot secretly replace an expired assignment");
});

test("a pinned pallet edited from 84 to 42 crates fails even with unrelated valid inventory", () => {
  const originallyPinned = pallet("pinned", 84);
  const changed = pallet("pinned", 42);
  const substitute = pallet("other-full", 84);
  const plan = { ...shipment(84), deliveries: [{
    ...shipment(84).deliveries[0], pallets: [originallyPinned],
  }] };
  const issues = auditShipmentAvailability(settings, [changed, substitute],
    [plan], [], today);
  assert.ok(issues.some((issue) =>
    issue.productId === "pallet:pinned" && issue.severity === "blocking"),
  "indivisible physical picks require exact quantities");
});

test("FEFO whole-pallet picker agrees with independent exhaustive oracle over 80 stock patterns", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const quantities = Array.from({ length: 8 }, (_, index) =>
      1 + ((seed * 13 + index * 11 + index * index * 7) % 19));
    const target = 1 + ((seed * 29) % 90);
    const lots: ForecastPalletLot[] = quantities.map((quantity, index) => ({
      id: `oracle-${seed}-${index}`, expiry: "2026-12-31", quantity,
    }));
    const initialUnits = quantities.reduce((sum, quantity) => sum + quantity, 0);
    const result = dispatchForecastPallets(lots, target, 84, "2026-10-19");
    let maximum = 0;
    for (let mask = 0; mask < (1 << quantities.length); mask++) {
      const units = quantities.reduce((sum, quantity, index) =>
        sum + (mask & (1 << index) ? quantity : 0), 0);
      if (units <= target && units > maximum) maximum = units;
    }
    assert.equal(result.shippedPhysical, maximum,
      `seed ${seed}: must select the most stock without overdispatching`);
    assert.equal(result.missingUnits, target - maximum);
    assert.equal(result.selectedLots.reduce((sum, lot) => sum + lot.quantity, 0),
      result.shippedPhysical);
    assert.equal(lots.reduce((sum, lot) => sum + lot.quantity, 0) +
      result.shippedPhysical, initialUnits, `seed ${seed}: stock must be conserved`);
    assert.equal(new Set([
      ...lots.map((lot) => lot.id), ...result.selectedLots.map((lot) => lot.id),
    ]).size, quantities.length, `seed ${seed}: never clone/reuse a pallet`);
  }
});

test("bounded FEFO DP conserves physical stock even for hundreds of fractional legacy pallets", () => {
  assert.equal(MAX_FEFO_SUBSET_STATES, 4096);
  const lots: ForecastPalletLot[] = Array.from({ length: 450 }, (_, index) => ({
    id: `legacy-${index}`, expiry: "2026-11-01",
    quantity: (101 + (index % 47)) / 1000,
  }));
  const startingUnits = lots.reduce((total, lot) => total + lot.quantity, 0);
  const result = dispatchForecastPallets(lots, 38.5, 84, "2026-10-20");
  assert.ok(result.shippedPhysical <= 38.5 + 1e-9, "no overdispatch on fractional quantities");
  assert.ok(result.shippedPhysical > 0, "a non-empty feasible subset is found");
  assert.ok(Math.abs(startingUnits -
    (result.shippedPhysical + lots.reduce((total, lot) => total + lot.quantity, 0))) < 1e-7,
    "each pallet exists in shipped or remaining physical inventory, never both");
  assert.equal(new Set(result.selectedLots.map((lot) => lot.id)).size, result.selectedLots.length);
});

test("explicit pinned later-expiry pallet leaves earlier FEFO stock for a different shipment", () => {
  const lots: ForecastPalletLot[] = [
    { id: "earlier", expiry: "2026-10-26", quantity: 84 },
    { id: "later", expiry: "2026-12-26", quantity: 84 },
  ];
  const pinned = [{ id: "later", quantity: 84 }];
  const reserved = reservedPhysicalPalletIds([{ pallets: pinned }]);
  const first = dispatchForecastPallets(lots, 84, 84, "2026-10-19", undefined, reserved);
  assert.deepEqual(first.selectedLots.map((lot) => lot.id), ["earlier"]);
  const second = dispatchForecastPallets(lots, 84, 84, "2026-10-20", pinned, reserved);
  assert.deepEqual(second.selectedLots.map((lot) => lot.id), ["later"]);
  assert.equal(second.missingUnits, 0);
  assert.equal(lots.length, 0);
});

test("future pinned earlier-expiry pallet cannot be borrowed by an earlier unpinned truck", () => {
  const first = pallet("reserved-for-later", 84, "26/10/2026");
  const second = pallet("free-for-now", 84, "31/12/2026");
  const week = { ...shipment(84), deliveries: [
    { ...shipment(84).deliveries[0], id: "truck-1", truckId: "first" },
    { ...shipment(84).deliveries[0], id: "truck-2", truckId: "second",
      dispatchDate: "2026-10-20", arrivalDate: "2026-10-20",
      pallets: [first] },
  ] };
  const noSales = { ...settings, products: [{ ...product, monthly: 0 }] };
  const issues = auditShipmentAvailability(noSales, [first, second], [week], [], today);
  assert.equal(issues.length, 0, "a valid future pin is protected from the earlier FEFO departure");
  const weekly = buildWeekStartProjection({
    settings: noSales, pallets: [first, second], plans: [week], actuals: [],
    today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(weekly?.breweryUnits, 0);
  assert.equal(weekly?.tempoUnits, 168);
  const daily = dailyForecast(noSales, [first, second], [], [week], [], today);
  assert.equal(daily.points.find((point) => point.date === "2026-10-20")?.brewery, 0);
});

test("same explicit pallet in two successive trips fails rather than borrowing substitute stock", () => {
  const same = pallet("reserved-twice", 84);
  const substitute = pallet("available-but-not-assigned", 84);
  const week = { ...shipment(84), deliveries: [
    { ...shipment(84).deliveries[0], id: "first", truckId: "A", pallets: [same] },
    { ...shipment(84).deliveries[0], id: "second", truckId: "B",
      dispatchDate: "2026-10-20", arrivalDate: "2026-10-20", pallets: [same] },
  ] };
  const noSales = { ...settings, products: [{ ...product, monthly: 0 }] };
  const issues = auditShipmentAvailability(noSales, [same, substitute], [week], [], today);
  assert.ok(issues.some((issue) => issue.productId === "pallet:reserved-twice" &&
    issue.date === "2026-10-20" && issue.severity === "blocking"));
  const opening = buildWeekStartProjection({
    settings: noSales, pallets: [same, substitute], plans: [week], actuals: [],
    today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(opening?.tempoUnits, 84, "only the one physically dispatched truck credits Tempo");
  assert.equal(opening?.breweryUnits, 84, "unassigned substitute remains in real inventory");
});

test("future expiry invalidates a pinned pallet even when other full pallets exist", () => {
  const expired = pallet("will-expire", 84, "19/10/2026");
  const substitute = pallet("valid-unassigned", 84);
  const lots: ForecastPalletLot[] = [
    { id: expired.id, expiry: "2026-10-19", quantity: 84 },
    { id: substitute.id, expiry: "2026-12-31", quantity: 84 },
  ];
  const result = dispatchForecastPallets(lots, 84, 84, "2026-10-20", [expired]);
  assert.equal(result.shippedPhysical, 0);
  assert.deepEqual(result.missingPinnedIds, ["will-expire"]);
  assert.deepEqual(lots.map((lot) => lot.id), ["valid-unassigned"]);
});

test("Tempo opening balance credits only 30 physically shippable crates, not 84 planned", () => {
  const noSales = { ...settings, products: [{ ...product, monthly: 0 }] };
  const physical = [pallet("partial", 30)];
  const planned = [shipment(84)];
  const issue = auditShipmentAvailability(noSales, physical, planned, [], today);
  assert.equal(issue[0].missingUnits, 54);
  const weekOpening = buildWeekStartProjection({
    settings: noSales, pallets: physical, plans: planned, actuals: [],
    today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(weekOpening?.shipmentsBeforeWeek, 84, "retain nominal planned units for review");
  assert.equal(weekOpening?.breweryUnits, 0);
  assert.equal(weekOpening?.tempoUnits, 30,
    "the future Tempo balance must never invent the 54 missing physical crates");
  const daily = dailyForecast(noSales, physical, [], planned, [], today);
  assert.equal(daily.points.find((p) => p.date === "2026-10-19")?.arrived, 30);
});

test("shipment physically dispatched but arriving next week is not in this week's opening Tempo", () => {
  const noSales = { ...settings, products: [{ ...product, monthly: 0 }] };
  const delayed = { ...shipment(84), deliveries: [{
    ...shipment(84).deliveries[0], arrivalDate: "2026-10-28",
  }] };
  const opening = buildWeekStartProjection({
    settings: noSales, pallets: [pallet("full", 84)], plans: [delayed],
    actuals: [], today, week: "2026-10-25",
  }).get(product.id);
  assert.equal(opening?.breweryUnits, 0, "the pallet already left the brewery");
  assert.equal(opening?.tempoUnits, 0, "the truck has not reached Tempo yet");
  const next = buildWeekStartProjection({
    settings: noSales, pallets: [pallet("full", 84)], plans: [delayed],
    actuals: [], today, week: "2026-11-01",
  }).get(product.id);
  assert.equal(next?.tempoUnits, 84, "arriving pallets appear only after physical arrival");
});
