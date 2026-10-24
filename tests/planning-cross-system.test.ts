import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, usableInventory,
  type Product, type DeliveryPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  shipmentActualManifestFromTotals, shipmentManifestScore,
  matchShipmentManifests, matchActualShipments,
  hasUnmatchedPhysicalDepartureForToday, settingsAfterActualShipments,
  forecastablePlansAfterActualShipments, pendingPlansAfterActualShipments,
} from "../src/SERVICES/planning/shipmentActuals";
import { planningReadRequirements, shipmentHistoryStart } from
  "../src/SERVICES/planning/planningReadCoverage";
import { isPhysicalTempoShipment } from
  "../src/SERVICES/planning/planningTempoShipmentFilter";
import { pendingStockExecutionPlans } from "../src/SERVICES/planning/planningStockExecution";
import { plannedTripsForDispatchDay, isDispatchTripInQueue } from
  "../src/SERVICES/planning/shipmentDispatchIdentityCore";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";

const ipa: Product = {
  id: "ipa-crates", sku: "ipa-crates", style: "IPA", type: "crates",
  tempo: 100, tempoDate: "2026-10-04", leadDays: 21, monthly: 360,
};
const wheat: Product = {
  ...ipa, id: "wheat-crates", sku: "wheat-crates", style: "חיטה", tempo: 0,
  tempoDate: "2026-10-20",
};
const products = [ipa, wheat];
const delivery = (id: string, truckId: string, productId: string,
  quantity: number, date = "2026-10-19"): DeliveryPlan =>
  ({ id, truckId, productId, quantity, dispatchDate: date, arrivalDate: date });
const planned = [delivery("a", "truck-a", ipa.id, 84)];
const resolve = (style: string, kind: string) =>
  kind === "crates" && style === "IPA" ? ipa.id :
  kind === "crates" && style === "חיטה" ? wheat.id : null;

test("Stock and Review never skip the same real Tempo receipts required by Gantt", () => {
  assert.deepEqual(planningReadRequirements("stock"),
    { pallets: true, actuals: true, shipments: true });
  assert.deepEqual(planningReadRequirements("review"),
    { pallets: false, actuals: true, shipments: true });
  assert.deepEqual(planningReadRequirements("fiveWeeks"),
    { pallets: true, actuals: true, shipments: true });
  assert.equal(shipmentHistoryStart("2026-10-18", products), "2026-10-04");
  assert.equal(shipmentHistoryStart("2026-10-18",
    [{ ...ipa, tempoDate: "2026-10-21" }]), "2026-10-18");
});

test("a two-week-old Tempo snapshot receives all later physical receipts once", () => {
  // Isolate shipment replay from sales; inventory depletion is covered
  // separately by the chronology invariants.
  const settings = { ...defaultSettings(), products: [{ ...ipa, monthly: 0 }] };
  const actuals = [
    { id: "older", date: "2026-10-12",
      totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }] },
    { id: "newer", date: "2026-10-20",
      totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 42 }] },
  ] as any;
  assert.equal(settingsAfterActualShipments(settings, actuals, "2026-10-24")
    .products[0].tempo, 226);
  const newSnapshot = { ...defaultSettings(), products: [
    { ...ipa, monthly: 0, tempo: 50, tempoDate: "2026-10-18" },
  ] };
  assert.equal(settingsAfterActualShipments(newSnapshot, actuals, "2026-10-24")
    .products[0].tempo, 92, "October 12 was already in the explicit count");
});

test("unknown actual lines reduce BOTH operational and UI match confidence", () => {
  const totals = [
    { itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 84 },
    { itemType: "crates" as const, beerStyle: "unknown-product", totalQuantity: 84 },
  ];
  const operationalManifest = shipmentActualManifestFromTotals(totals, resolve);
  assert.equal(operationalManifest["__unmapped__:crates:unknown-product"], 84);
  assert.equal(shipmentManifestScore({ [ipa.id]: 84 }, operationalManifest), .5);
  const queueMatches = matchShipmentManifests(planned, [{
    id: "sent", date: "2026-10-19", manifest: operationalManifest,
  }]);
  const uiMatches = matchActualShipments(planned, [{
    id: "sent", date: "2026-10-19", totals,
  }] as any, products);
  assert.equal(queueMatches[0].status, "pending");
  assert.equal(uiMatches[0].status, queueMatches[0].status);
});

test("directly linked partial physical departure closes the same trip in both engines", () => {
  const deliveries = [delivery("a", "truck-a", ipa.id, 84),
    delivery("b", "truck-b", wheat.id, 84)];
  const physical = [{
    id: "physical", date: "2026-10-19", plannedTruckId: "truck-b",
    totals: [{ itemType: "crates" as const, beerStyle: "חיטה", totalQuantity: 10 }],
  }];
  const manifest = shipmentActualManifestFromTotals(physical[0].totals, resolve);
  const normalized = [{ id: "physical", date: "2026-10-19",
    plannedTruckId: "truck-b", manifest }];
  const byQueue = matchShipmentManifests(deliveries, normalized);
  const byUI = matchActualShipments(deliveries, physical, products);
  assert.deepEqual(byUI.map((m) => [m.planned.id, m.status]),
    byQueue.map((m) => [m.planned.id, m.status]));
  assert.equal(byQueue.find((m) => m.planned.id === "truck-b")?.status, "actual-different");
  assert.equal(hasUnmatchedPhysicalDepartureForToday(byQueue, normalized, "2026-10-19"), false);
});

test("unlinked unexpected physical dispatch holds automatic allocation today", () => {
  const actual = [{ id: "physical", date: "2026-10-19",
    manifest: { [ipa.id]: 10, [wheat.id]: 74 } }];
  const matches = matchShipmentManifests(planned, actual);
  assert.equal(matches[0].status, "pending");
  assert.equal(hasUnmatchedPhysicalDepartureForToday(matches, actual, "2026-10-19"), true);
  assert.equal(hasUnmatchedPhysicalDepartureForToday(matches, actual, "2026-10-18"), false);
  assert.equal(hasUnmatchedPhysicalDepartureForToday(
    matchShipmentManifests([delivery("next", "truck-next", ipa.id, 84,
      "2026-10-20")], actual), actual, "2026-10-19"), false);
});

test("a directly linked departure today NEVER hides the second pending same-day truck", () => {
  const week = { ...emptyWeek("2026-10-18"), deliveries: [
    delivery("a", "truck-a", ipa.id, 84),
    delivery("b", "truck-b", wheat.id, 84),
  ] };
  const actual = [{
    id: "actual-first", date: "2026-10-19", plannedTruckId: "truck-a",
    totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 84 }],
  }];
  const pending = pendingPlansAfterActualShipments([week], actual, products);
  const forecast = forecastablePlansAfterActualShipments([week], actual,
    products, "2026-10-19");
  assert.deepEqual(pending[0].deliveries?.map((d) => d.truckId), ["truck-b"]);
  assert.deepEqual(forecast[0].deliveries?.map((d) => d.truckId), ["truck-b"],
    "completed truck is already matched against the original complete manifest");
});

test("linked partial first truck and unrelated orphan receipt hold only risky dispatch dates", () => {
  const week = { ...emptyWeek("2026-10-18"), deliveries: [
    delivery("a", "truck-a", ipa.id, 84),
    delivery("b", "truck-b", wheat.id, 84),
    delivery("c", "truck-c", ipa.id, 84, "2026-10-20"),
  ] };
  const linked = [{
    id: "partial-first", date: "2026-10-19", plannedTruckId: "truck-a",
    totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 12 }],
  }];
  const normal = forecastablePlansAfterActualShipments([week], linked, products,
    "2026-10-20")[0];
  assert.deepEqual(normal.deliveries?.map((d) => d.truckId), ["truck-b", "truck-c"]);
  const orphan = {
    id: "unknown-departure", date: "2026-10-19",
    totals: [{ itemType: "crates" as const, beerStyle: "UNKNOWN", totalQuantity: 11 }],
  };
  const held = forecastablePlansAfterActualShipments([week], [...linked, orphan],
    products, "2026-10-20")[0];
  assert.deepEqual(held.deliveries?.map((d) => d.truckId), ["truck-c"],
    "an extra genuinely unmatched dispatch quarantines only its same-day trips");
});

test("physical trip chooser validates the requested dispatch date and queue revision", () => {
  const queue = { projectionVersion: 1, deliveries: [
    delivery("a", "truck-a", ipa.id, 84),
    delivery("a2", "truck-a", wheat.id, 42),
    delivery("b", "truck-b", ipa.id, 84, "2026-10-20"),
  ] };
  const choices = plannedTripsForDispatchDay(queue.deliveries, "2026-10-19");
  assert.equal(choices.length, 1);
  assert.equal(choices[0].id, "truck-a");
  assert.equal(choices[0].manifest.length, 2);
  assert.equal(isDispatchTripInQueue(queue, "2026-10-19", "truck-a"), true);
  assert.equal(isDispatchTripInQueue(queue, "2026-10-19", "truck-b"), false);
  assert.equal(isDispatchTripInQueue({ ...queue, projectionVersion: 0 },
    "2026-10-19", "truck-a"), false);
});

test("Stock action model removes fulfilled shipments and completed same-day packaging", () => {
  const keg: Product = { ...ipa, id: "ipa-kegs", sku: "ipa-kegs", type: "kegs" };
  const plan = { ...emptyWeek("2026-10-18"), deliveries: planned,
    packaging: [{ id: "pack-4", productId: keg.id,
      tankId: "tank-4", tankNumber: "4", batchNumber: "1614",
      quantity: 56, date: "2026-10-20" }] };
  const packed = [{ id: "actual-kegs", date: "2026-10-20",
    tankNumber: 4, batchNumber: "1614", beerStyle: "IPA",
    packagingType: "kegs", unit: "חביות", quantity: 56 }] as any;
  const shipment = [{
    id: "actual-ship", date: "2026-10-19", plannedTruckId: "truck-a",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }],
  }] as any;
  const source = [{ id: "tank-4", tankNumber: 4,
    batchNumber: "1614", tankStatus: true }];
  const remaining = pendingStockExecutionPlans([plan], [ipa, keg], packed, shipment, source);
  assert.equal(remaining[0].deliveries?.length, 0);
  assert.equal(remaining[0].packaging.length, 0);
});

test("usable physical stock cannot include expired or unknown-expiry pallets", () => {
  const pallet = (id: string, expiryDateStr?: string): Pallet =>
    ({ id, beerStyle: "IPA", itemType: "crates", zone: "cooler",
      quantity: 84, expiryDateStr, heightUnits: 1 });
  const stock = [pallet("valid", "31/12/2026"), pallet("expired", "01/10/2026"),
    pallet("unknown")];
  assert.equal(usableInventory(ipa, stock, "2026-10-24").brewery, 84);
});

test("unlinked same-day physical departure remains pending for review but is NOT dispatched twice in forecasts", () => {
  const week = { ...emptyWeek("2026-10-18"), deliveries: planned };
  const actuals = [{
    id: "physical-unlinked", date: "2026-10-19",
    totals: [
      { itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 10 },
      { itemType: "crates" as const, beerStyle: "חיטה", totalQuantity: 74 },
    ],
  }];
  assert.equal(pendingPlansAfterActualShipments([week], actuals, products)[0]
    .deliveries?.length, 1, "the operator still needs to reconcile the trip");
  assert.equal(forecastablePlansAfterActualShipments([week], actuals, products,
    "2026-10-19")[0].deliveries?.length, 0,
    "an unresolved departure cannot consume stock or credit Tempo again in forecasts");
  assert.equal(forecastablePlansAfterActualShipments([week], actuals, products,
    "2026-10-18")[0].deliveries?.length, 1,
    "tomorrow's trip is not quarantined by a future receipt");
});

test("two planned trucks on different days are not both quarantined by one unlinked receipt", () => {
  const week = { ...emptyWeek("2026-10-18"), deliveries: [
    ...planned, delivery("b", "truck-b", wheat.id, 84, "2026-10-20"),
  ] };
  const actual = [{ id: "unlinked", date: "2026-10-19",
    totals: [{ itemType: "crates" as const, beerStyle: "unknown",
      totalQuantity: 100 }] }];
  const forecast = forecastablePlansAfterActualShipments([week], actual,
    products, "2026-10-20");
  assert.deepEqual(forecast[0].deliveries?.map((d) => d.truckId), ["truck-b"]);
});

test("paper-only Tempo invoice cannot close or hold a physical shipment trip", () => {
  assert.equal(isPhysicalTempoShipment({
    sourceType: "manual", customerId: "tempo",
    totals: [], manualLines: [{ sku: "ipa-crates", quantity: 84 }],
  }), false);
  assert.equal(isPhysicalTempoShipment({
    sourceType: "pallets", customerId: "tempo",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }],
  }), true);
  assert.equal(isPhysicalTempoShipment({
    sourceType: "pallets", customerName: "אחר",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }],
  }), false);
});
