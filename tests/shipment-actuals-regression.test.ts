import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, type DeliveryPlan, type Product } from "../src/SERVICES/planning/planningEngine";
import {
  completedShipmentQueueTruckId,
  matchActualShipments,
  pendingDeliveriesForReservationQueue,
  settingsAfterActualShipments,
} from "../src/SERVICES/planning/shipmentActuals";

const product: Product = {
  id: "ipa-crates",
  sku: "ipa-crates",
  style: "IPA",
  type: "crates",
  monthly: 420,
  tempo: 100,
  tempoDate: "2026-09-10",
  leadDays: 21,
};

test("actual shipments are added to Tempo forecast after the last stock snapshot", () => {
  const settings = { ...defaultSettings(), products: [product] };
  const next = settingsAfterActualShipments(settings, [{
    id: "shipment-1",
    date: "2026-09-14",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }],
  } as any], "2026-09-14");

  // Four days of sales occur between the old stock count and receipt.
  // The correct current balance is 100 - 4*(420/4.2/7) + 84.
  assert.ok(Math.abs(next.products[0].tempo! -
    (100 - 4 * (420 / 4.2 / 7) + 84)) < 1e-8);
});

test("shipment is not added twice when Tempo snapshot is newer than the shipment", () => {
  const settings = {
    ...defaultSettings(),
    products: [{ ...product, tempo: 150, tempoDate: "2026-09-14" }],
  };
  const next = settingsAfterActualShipments(settings, [{
    id: "shipment-1",
    date: "2026-09-13",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }],
  } as any], "2026-09-14");

  assert.equal(next.products[0].tempo, 150);
});

function delivery(
  id: string,
  truckId: string,
  productId: string,
  quantity: number,
  dispatchDate: string,
): DeliveryPlan {
  return {
    id,
    truckId,
    productId,
    quantity,
    dispatchDate,
    arrivalDate: dispatchDate,
  };
}

test("completed shipment closes the matching queue trip, not merely the closest date", () => {
  const deliveries = [
    delivery("a-ipa", "truck-a", "ipa-crates", 84, "2026-10-04"),
    delivery("b-wheat", "truck-b", "wheat-crates", 84, "2026-10-05"),
  ];

  const closed = completedShipmentQueueTruckId(
    deliveries,
    { "wheat-crates": 84 },
    "2026-10-04",
  );

  assert.equal(closed, "truck-b");
});

test("completed shipment with no catalog overlap cannot close an unrelated same-week trip", () => {
  const deliveries = [
    delivery("a", "truck-a", "ipa-crates", 84, "2026-10-04"),
    delivery("b", "truck-b", "wheat-crates", 84, "2026-10-06"),
  ];

  const closed = completedShipmentQueueTruckId(
    deliveries,
    { "unknown-product": 1 },
    "2026-10-05",
  );

  assert.equal(closed, null);
});

test("completed shipment never closes a queue trip from another operational week", () => {
  const deliveries = [
    delivery("next", "truck-next", "ipa-crates", 84, "2026-10-11"),
  ];

  const closed = completedShipmentQueueTruckId(
    deliveries,
    { "ipa-crates": 84 },
    "2026-10-04",
  );

  assert.equal(closed, null);
});

test("weak manifest overlap must not close a trip or release its reservation", () => {
  const products = [product, { ...product, id: "wheat-crates", style: "חיטה" }];
  const deliveries = [
    delivery("a", "truck-a", "ipa-crates", 84, "2026-10-19"),
  ];
  const weak = [{
    id: "physical-1", date: "2026-10-19",
    totals: [
      { itemType: "crates", beerStyle: "IPA", totalQuantity: 10 },
      { itemType: "crates", beerStyle: "חיטה", totalQuantity: 74 },
    ],
  }] as any;
  assert.equal(completedShipmentQueueTruckId(deliveries,
    { "ipa-crates": 10, "wheat-crates": 74 }, "2026-10-19"), null);
  assert.equal(matchActualShipments(deliveries, weak, products)[0].status, "pending");
  assert.equal(pendingDeliveriesForReservationQueue(deliveries, weak, products).length, 1);
});

test("unknown extra products lower confidence instead of being silently ignored", () => {
  const deliveries = [delivery("a", "truck-a", "ipa-crates", 84, "2026-10-19")];
  const actual = [{
    id: "physical-1", date: "2026-10-19",
    totals: [
      { itemType: "crates", beerStyle: "IPA", totalQuantity: 84 },
      { itemType: "crates", beerStyle: "not-in-catalog", totalQuantity: 84 },
    ],
  }] as any;
  assert.equal(matchActualShipments(deliveries, actual, [product])[0].status, "pending");
});

test("direct truck identity closes the right trip even when actual quantities differ", () => {
  const deliveries = [
    delivery("a", "truck-a", "ipa-crates", 84, "2026-10-19"),
    delivery("b", "truck-b", "ipa-crates", 168, "2026-10-19"),
  ];
  const physical = [{
    id: "actual-from-b", date: "2026-10-19", plannedTruckId: "truck-b",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 30 }],
  }] as any;
  const matches = matchActualShipments(deliveries, physical, [product]);
  assert.equal(matches.find((m) => m.planned.id === "truck-b")?.status, "actual-different");
  assert.equal(matches.find((m) => m.planned.id === "truck-a")?.status, "pending");
  assert.equal(completedShipmentQueueTruckId(deliveries,
    { "ipa-crates": 30 }, "2026-10-19", "truck-b"), "truck-b");
});

test("identical high-confidence manifest ties can close only one interchangeable trip", () => {
  const deliveries = [
    delivery("a", "truck-a", "ipa-crates", 84, "2026-10-19"),
    delivery("b", "truck-b", "ipa-crates", 84, "2026-10-19"),
  ];
  const actual = [{
    id: "physical-1", date: "2026-10-19",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 84 }],
  }] as any;
  assert.equal(matchActualShipments(deliveries, actual, [product])
    .filter((m) => m.status !== "pending").length, 1);
  assert.equal(completedShipmentQueueTruckId(deliveries, { "ipa-crates": 84 },
    "2026-10-19"), "truck-a");
});

test("two different manifests tied on match score remain open unless linked", () => {
  const wheat = { ...product, id: "wheat-crates", style: "חיטה" };
  const deliveries = [
    delivery("a", "truck-a", "ipa-crates", 84, "2026-10-19"),
    delivery("b", "truck-b", "wheat-crates", 84, "2026-10-19"),
  ];
  const actual = [{
    id: "physical-1", date: "2026-10-19",
    totals: [
      { itemType: "crates", beerStyle: "IPA", totalQuantity: 84 },
      { itemType: "crates", beerStyle: "חיטה", totalQuantity: 84 },
    ],
  }] as any;
  assert.equal(completedShipmentQueueTruckId(deliveries,
    { "ipa-crates": 84, "wheat-crates": 84 }, "2026-10-19"), null);
  assert.equal(matchActualShipments(deliveries, actual, [product, wheat])
    .filter((m) => m.status !== "pending").length, 0);
});
