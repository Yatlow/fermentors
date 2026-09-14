import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, type Product } from "../src/SERVICES/planning/planningEngine";
import { settingsAfterActualShipments } from "../src/SERVICES/planning/shipmentActuals";

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
