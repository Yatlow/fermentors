import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { buildShipmentRecommendation } from "../src/SERVICES/planning/shipmentRecommendation";
import { shipmentDecisionPickOptions } from "../src/SERVICES/planning/shipmentDecisionPicking";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";

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
