import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, type DeliveryPlan, type Product } from "../src/SERVICES/planning/planningEngine";
import {
  completedShipmentQueueTruckId,
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

  assert.equal(next.products[0].tempo, 184);
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

test("completed shipment with no catalog overlap still closes the nearest same-week trip", () => {
  const deliveries = [
    delivery("a", "truck-a", "ipa-crates", 84, "2026-10-04"),
    delivery("b", "truck-b", "wheat-crates", 84, "2026-10-06"),
  ];

  const closed = completedShipmentQueueTruckId(
    deliveries,
    { "unknown-product": 1 },
    "2026-10-05",
  );

  assert.equal(closed, "truck-a");
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
