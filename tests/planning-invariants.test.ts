import { test } from "node:test";
import assert from "node:assert/strict";
import { tempoInventoryAt } from "../src/SERVICES/planning/tempoInventoryTimeline";
import { openRuns } from "../src/SERVICES/planning/dailyPlanner";
import { tankReleases } from "../src/SERVICES/planning/productionCycle";
import { pendingStockExecutionPlans } from "../src/SERVICES/planning/planningStockExecution";
import { matchActualShipments, settingsAfterActualShipments } from "../src/SERVICES/planning/shipmentActuals";
import { validatePhysicalShipmentLoad } from "../src/SERVICES/cooler/shipmentDispatchSafety";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";

const stock: Product = {
  id: "ipa-crates", sku: "ipa-crates", type: "crates", style: "IPA",
  monthly: 294, tempo: 0, tempoDate: "2026-10-01", leadDays: 21,
}; // demand exactly 10 crates/day (294/4.2/7)

test("Tempo ledger applies sales between receipts, not all sales before receipts", () => {
  assert.equal(tempoInventoryAt(stock, "2026-10-05", [
    { date: "2026-10-03", quantity: 100 },
  ]), 80);
});

test("Tempo ledger clamps each chronological sales interval to zero", () => {
  assert.equal(tempoInventoryAt(stock, "2026-10-09", [
    { date: "2026-10-03", quantity: 30 },
    { date: "2026-10-06", quantity: 60 },
  ]), 30);
});

test("same-day Tempo snapshot includes only later physically timestamped receipts", () => {
  const baseline: Product = { ...stock, tempo: 20, tempoDate: "2026-10-03",
    tempoSnapshotAt: "2026-10-03T10:00:00+03:00" };
  const receipts = [
    { date: "2026-10-03", occurredAt: "2026-10-03T09:00:00+03:00", quantity: 50 },
    { date: "2026-10-03", occurredAt: "2026-10-03T11:00:00+03:00", quantity: 30 },
  ];
  assert.equal(tempoInventoryAt(baseline, "2026-10-03", receipts), 50);
  // Replaying the same receipts on a derived current-day baseline must be idempotent.
  const settings = { ...defaultSettings(), products: [baseline] };
  const actuals = receipts.map((receipt, index) => ({
    id: "shipment-" + index, ...receipt,
    totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: receipt.quantity }],
  }));
  const first = settingsAfterActualShipments(settings, actuals, "2026-10-03");
  assert.equal(first.products[0].tempo, 50);
  assert.equal(settingsAfterActualShipments(first, actuals, "2026-10-03")
    .products[0].tempo, 50);
});

test("older Tempo snapshots without precise time conservatively skip same-day receipts", () => {
  const baseline = { ...stock, tempo: 20, tempoDate: "2026-10-03" };
  assert.equal(tempoInventoryAt(baseline, "2026-10-03", [
    { date: "2026-10-03", occurredAt: "2026-10-03T11:00:00+03:00", quantity: 30 },
  ]), 20);
});

test("reconciliation on an old stock count replays sales and physical receipts", () => {
  const settings = { ...defaultSettings(), products: [stock] };
  const shipments = [{
    id: "physical", date: "2026-10-03",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 100 }],
  }] as any;
  const current = settingsAfterActualShipments(settings, shipments, "2026-10-05");
  assert.equal(current.products[0].tempo, 80);
  assert.equal(current.products[0].tempoDate, "2026-10-05");
});

test("physical packaging can be completed across the week boundary, never twice", () => {
  const p = { ...stock, tempo: null };
  const first = { ...emptyWeek("2026-10-25"), packaging: [{
    id: "first-run", productId: p.id, quantity: 60,
    tankNumber: "4", batchNumber: "1640", date: "2026-10-26",
  }] };
  const second = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "second-run", productId: p.id, quantity: 40,
    tankNumber: "4", batchNumber: "1640", date: "2026-11-02",
  }] };
  const report = [{ id: "actual", date: "2026-10-29", quantity: 70,
    tankNumber: "4", batchNumber: "1640", beerStyle: "IPA",
    packagingType: "bottles", unit: "ארגזים" }];
  const runs = openRuns([second, first], [p], report);
  assert.deepEqual(runs.map((r) => [r.id, r.remaining]),
    [["first-run", 0], ["second-run", 30]]);
  assert.equal(runs.reduce((sum, r) => sum + r.remaining, 0), 30);
});

test("a cross-week report from a DIFFERENT batch cannot fulfill future packaging", () => {
  const future = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "other", productId: stock.id, quantity: 40,
    tankNumber: "4", batchNumber: "1641", date: "2026-11-02",
  }] };
  const reports = [{ id: "old-batch", date: "2026-10-29", quantity: 80,
    tankNumber: "4", batchNumber: "1640", beerStyle: "IPA",
    packagingType: "bottles", unit: "ארגזים" }];
  assert.equal(openRuns([future], [stock], reports)[0].remaining, 40);
});

test("85%-confidence identification is still flagged actual-different at 90%", () => {
  const deliveries = [{ id: "truck-row", truckId: "truck-A", productId: stock.id,
    quantity: 100, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" }];
  const actual = [{ id: "actual", date: "2026-10-19",
    totals: [{ itemType: "crates", beerStyle: "IPA", totalQuantity: 90 }] }];
  const match = matchActualShipments(deliveries, actual, [stock])[0];
  assert.equal(match.actual?.id, "actual");
  assert.equal(match.status, "actual-different");
  assert.equal(match.score, .9);
});

const pallet = (id: string, qty: number, expiry = "31/12/2026",
  zone = "loadingDock"): Pallet => ({
  id, beerStyle: "IPA", itemType: "crates", quantity: qty,
  expiryDateStr: expiry, zone,
}) as Pallet;

test("physical dispatch rejects 13 full loading positions even if UI is bypassed", () => {
  assert.throws(() => validatePhysicalShipmentLoad(
    Array.from({ length: 13 }, (_, i) => pallet("p" + i, 84)), "2026-10-24"),
    /12 מקומות/);
});

test("actual physical dispatch permits three-plus low pallets per slot, but rejects overflow", () => {
  const shortPallets = Array.from({ length: 49 }, (_, index) =>
    pallet(`short-${index}`, 12));
  assert.throws(() => validatePhysicalShipmentLoad(shortPallets, "2026-10-24"),
    /12 מקומות/, "the combined height still limits the truck to 12 floor places");
  const legal = shortPallets.slice(0, 48);
  assert.equal(validatePhysicalShipmentLoad(legal, "2026-10-24"), 12);
});

test("physical dispatch rejects expired, missing expiry, wrong zone and invalid quantity", () => {
  assert.throws(() => validatePhysicalShipmentLoad([pallet("expired", 84, "01/10/2026")],
    "2026-10-24"), /תאריך התפוגה/);
  assert.throws(() => validatePhysicalShipmentLoad([pallet("unknown", 84, "")],
    "2026-10-24"), /תאריך התפוגה/);
  assert.throws(() => validatePhysicalShipmentLoad([pallet("not-dock", 84, "31/12/2026", "cooler")],
    "2026-10-24"), /משטח הטעינה/);
  assert.throws(() => validatePhysicalShipmentLoad([pallet("invalid", 0)],
    "2026-10-24"), /כמות/);
  assert.doesNotThrow(() => validatePhysicalShipmentLoad([pallet("okay", 84)],
    "2026-10-24"));
});

test("Stock tasks cannot count one cross-week physical packaging report twice", () => {
  const p = { ...stock, tempo: null };
  const earlier = { ...emptyWeek("2026-10-25"), packaging: [{
    id: "first-run", productId: p.id, quantity: 60,
    tankNumber: "4", batchNumber: "1640", date: "2026-10-26",
  }] };
  const later = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "second-run", productId: p.id, quantity: 40,
    tankNumber: "4", batchNumber: "1640", date: "2026-11-02",
  }] };
  const actuals = [{
    id: "physical-pack", date: "2026-10-29", beerStyle: "IPA",
    packagingType: "bottles", unit: "ארגזים",
    tankNumber: "4", batchNumber: "1640", quantity: 70,
  }];
  const remaining = pendingStockExecutionPlans([later, earlier], [p], actuals, [], []);
  assert.deepEqual(remaining.map((week) =>
    [week.id, week.packaging.map((run) => run.quantity)]),
    [["2026-11-01", [30]], ["2026-10-25", []]]);
});

test("tank release follows a fully completed cross-week final packaging day", () => {
  const keg: Product = { ...stock, id: "ipa-kegs", sku: "ipa-kegs", type: "kegs" };
  const settings = { ...defaultSettings(), products: [keg] };
  const source = [{
    id: "tank4", tankNumber: "4", batchNumber: "1640",
    beerStyle: "IPA", brewDate: "01/10/2026", action: 1, tankStatus: false,
  }];
  const physicalTank = [{
    id: "tank4", number: "4", batch: "1640", style: "IPA",
    brewed: "2026-10-01", ready: "2026-10-20", liters: 1100, cold: true,
  }];
  const planned = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "last-kegs", productId: keg.id, tankId: "tank4",
    tankNumber: "4", batchNumber: "1640",
    date: "2026-11-02", quantity: 55, emptyTank: true,
  }] };
  const actual = [{
    id: "early", date: "2026-10-29", beerStyle: "IPA",
    packagingType: "kegs", unit: "חביות", quantity: 55,
    tankNumber: "4", batchNumber: "1640",
  }];
  const complete = tankReleases(source, physicalTank, [planned], settings, actual, "2026-10-30")[0];
  assert.equal(complete.emptyDate, "2026-10-29");
  assert.equal(complete.date, "2026-11-02");
  const incomplete = tankReleases(source, physicalTank, [planned], settings,
    [{ ...actual[0], quantity: 50 }], "2026-10-30")[0];
  assert.notEqual(incomplete.emptyDate, "2026-10-29",
    "a partial early report must not falsely release the physical tank");
});
