import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product, type WeekPlan } from "../src/SERVICES/planning/planningEngine";
import { auditShipmentAvailability, classifyPlanningShortageIncreases, newlyWorsenedShipmentShortages } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { confirmableUnpackedShipmentShortages, sameWeekUnscheduledPackagingUnits, unscheduledPackagingBeforeShipment, previousUncoveredShipmentUnits } from "../src/SERVICES/planning/shipmentProvisionalPlanning";

const today = "2026-11-04";
const weekId = "2026-11-08";
const product = (id: string, style: string, type: "crates" | "kegs"): Product => ({
  id, sku: id, style, type, monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
});
const stout = product("stout-crates", "סטאוט", "crates");
const wheat = product("wheat-kegs", "חיטה", "kegs");
const products = [stout, wheat];
const settings = { ...defaultSettings(), products };

const weeklyDecision = (sku: Product, packagingQty: number, shipmentQty: number, date?: string): WeekPlan => ({
  ...emptyWeek(weekId),
  packaging: [{ id: "pack", productId: sku.id, tankId: "8", quantity: packagingQty, ...(date ? { date } : {}) }],
  deliveries: [{ id: "ship", truckId: "truck-a", productId: sku.id,
    dispatchDate: "2026-11-09", arrivalDate: "2026-11-09", quantity: shipmentQty }],
});
const shortages = (weeks: WeekPlan[]) =>
  newlyWorsenedShipmentShortages(
    auditShipmentAvailability(settings, [], [], [], today),
    auditShipmentAvailability(settings, [], weeks, [], today));

test("stout crates: allow a confirmed provisional shipment against undated packaging", () => {
  const plans = [weeklyDecision(stout, 131, 84)];
  const issues = shortages(plans);
  assert.equal(issues.length, 1);
  assert.equal(classifyPlanningShortageIncreases(issues, weekId).blocking.length, 1);
  assert.equal(sameWeekUnscheduledPackagingUnits(plans, products, [], weekId, stout.id), 131);
  const provisional = confirmableUnpackedShipmentShortages(issues, plans, products, [], weekId);
  assert.equal(provisional.length, 1);
  assert.equal(classifyPlanningShortageIncreases(issues.filter((issue) => !provisional.includes(issue)), weekId).blocking.length, 0);
  assert.equal(auditShipmentAvailability(settings, [], plans, [], today)[0]?.severity, "blocking",
    "a saved provisional shipment is still physically short until packaging happens");
});

test("wheat kegs: planned, unpacked kegs can back next week's draft", () => {
  const plans = [weeklyDecision(wheat, 105, 60)];
  assert.equal(confirmableUnpackedShipmentShortages(shortages(plans), plans, products, [], weekId).length, 1);
});

test("no packaging or a known post-dispatch packaging date cannot waive a shortage", () => {
  for (const plans of [
    [weeklyDecision(stout, 0, 84)],
    [weeklyDecision(stout, 131, 84, "2026-11-10")],
  ]) {
    assert.equal(confirmableUnpackedShipmentShortages(shortages(plans), plans, products, [], weekId).length, 0);
  }
});

test("a shipment bigger than undated production stays blocked", () => {
  const plans = [weeklyDecision(stout, 30, 84)];
  assert.equal(confirmableUnpackedShipmentShortages(shortages(plans), plans, products, [], weekId).length, 0);
});

test("two trucks cannot both claim one undated packaging lot", () => {
  const plan = weeklyDecision(stout, 84, 84);
  plan.deliveries!.push({
    id: "second", truckId: "truck-b", productId: stout.id, quantity: 84,
    dispatchDate: "2026-11-10", arrivalDate: "2026-11-10",
  });
  const plans = [plan];
  const issues = shortages(plans);
  assert.equal(issues.length, 2);
  assert.equal(confirmableUnpackedShipmentShortages(issues, plans, products, [], weekId).length, 0);
});

test("physical pinned-pallet and truck safety problems cannot be made provisional", () => {
  const plans = [weeklyDecision(stout, 200, 84)];
  const forged = [
    { issue: { week: weekId, date: "2026-11-09", productId: "pallet:missing", missing: 1, missingUnits: 84, severity: "blocking" as const, message: "" }, addedSlots: 1, addedUnits: 84, totalSlots: 1, totalUnits: 84 },
    { issue: { week: weekId, date: "2026-11-09", productId: "truck:over", missing: 1, missingUnits: 84, severity: "blocking" as const, message: "" }, addedSlots: 1, addedUnits: 84, totalSlots: 1, totalUnits: 84 },
  ];
  assert.equal(confirmableUnpackedShipmentShortages(forged, plans, products, [], weekId).length, 0);
});

test("completed packaging reports reduce the provisional entitlement", () => {
  const plans = [weeklyDecision(wheat, 80, 60)];
  const reported = [{ id: "reported", date: "2026-11-04", beerStyle: wheat.style,
    packagingType: "kegs", quantity: 40, batchNumber: "1615", tankNumber: 8 }];
  // A same-batch report may be associated with the outstanding weekly run.
  plans[0].packaging[0].tankNumber = "8";
  plans[0].packaging[0].batchNumber = "1615";
  const outstanding = sameWeekUnscheduledPackagingUnits(plans, products, reported, weekId, wheat.id);
  assert.equal(outstanding, 40);
  assert.equal(confirmableUnpackedShipmentShortages(shortages(plans), plans, products, reported, weekId).length, 0);
});

const earlierWeek = "2026-11-01";
const earlierPack = (sku: Product, quantity: number, date?: string): WeekPlan => ({
  ...emptyWeek(earlierWeek),
  packaging: [{
    id: "previous-pack", productId: sku.id, tankId: "tank-3",
    tankNumber: "3", batchNumber: "1609", quantity,
    ...(date ? { date } : {}),
  }],
});
const nextWeekShip = (sku: Product, quantity: number): WeekPlan => ({
  ...emptyWeek(weekId),
  deliveries: [{
    id: "next-shipment", truckId: "truck-next", productId: sku.id,
    dispatchDate: "2026-11-09", arrivalDate: "2026-11-09", quantity,
  }],
});
function classifyAcrossWeeks(plans: WeekPlan[]) {
  const after = auditShipmentAvailability(settings, [], plans, [], today);
  const changes = newlyWorsenedShipmentShortages([], after);
  return {
    after,
    confirmed: confirmableUnpackedShipmentShortages(
      changes, plans, products, [], weekId, today, after),
    changes,
  };
}

test("regression 2026-11-08: prior-week Stout crates and Wheat kegs support next-week provisional shipment", () => {
  const previousStout = earlierPack(stout, 131);
  const previousWheat = earlierPack(wheat, 105);
  previousStout.packaging[0].tankId = "tank-3";
  previousWheat.packaging[0].tankId = "tank-8";
  const shipping = nextWeekShip(stout, 84);
  shipping.deliveries!.push(...nextWeekShip(wheat, 60).deliveries!);
  const plans = [previousStout, previousWheat, shipping];
  assert.equal(unscheduledPackagingBeforeShipment(plans, products, [], today, weekId, stout.id), 131);
  assert.equal(unscheduledPackagingBeforeShipment(plans, products, [], today, weekId, wheat.id), 105);
  const { after, confirmed, changes } = classifyAcrossWeeks(plans);
  assert.equal(changes.length, 2);
  assert.equal(confirmed.length, 2, "both SKUs can be planned after confirmation");
  assert.equal(after.filter((issue) => issue.severity === "blocking").length, 2,
    "the Gantt still reports missing PHYSICAL pallets until actual packaging");
});

test("previous-week packaging must not be credited twice for separate shipments", () => {
  const prior = earlierPack(stout, 131);
  prior.deliveries = [{
    id: "first", productId: stout.id, truckId: "first",
    dispatchDate: "2026-11-05", arrivalDate: "2026-11-05", quantity: 84,
  }];
  const next = nextWeekShip(stout, 84);
  const plans = [prior, next];
  const { confirmed, after } = classifyAcrossWeeks(plans);
  assert.equal(previousUncoveredShipmentUnits(after, stout.id, today, weekId), 84);
  assert.equal(confirmed.length, 0,
    "131 outstanding crates cannot cover two separate deliveries of 84");
});

test("only undated current or intervening week packaging is eligible", () => {
  const stale = { ...earlierPack(stout, 131), id: "2026-10-25" };
  const future = { ...earlierPack(stout, 131), id: "2026-11-15" };
  const datedAfter = earlierPack(stout, 131, "2026-11-10");
  const shipping = nextWeekShip(stout, 84);
  for (const pack of [stale, future, datedAfter]) {
    const plans = [pack, shipping];
    assert.equal(unscheduledPackagingBeforeShipment(plans, products, [], today, weekId, stout.id), 0);
    assert.equal(classifyAcrossWeeks(plans).confirmed.length, 0);
  }
});

test("less than the shipped units of previous-week packaging still blocks", () => {
  const plans = [earlierPack(wheat, 30), nextWeekShip(wheat, 60)];
  assert.equal(classifyAcrossWeeks(plans).confirmed.length, 0);
});

test("reported earlier-week packaging reduces the provisional outstanding quantity", () => {
  const plans = [earlierPack(wheat, 80), nextWeekShip(wheat, 60)];
  const reports = [{
    id: "physical-kegs", date: "2026-11-04", tankNumber: "3",
    batchNumber: "1609", beerStyle: "חיטה", packagingType: "kegs", quantity: 40,
  }];
  assert.equal(unscheduledPackagingBeforeShipment(plans, products, reports, today, weekId, wheat.id), 40);
  const after = auditShipmentAvailability(settings, [], plans, reports, today);
  const increases = newlyWorsenedShipmentShortages([], after);
  assert.equal(confirmableUnpackedShipmentShortages(
    increases, plans, products, reports, weekId, today, after).length, 0);
});

test("chronological guard prevents later-week packaging from covering an earlier-week shortage", () => {
  const earlierShipping = { ...emptyWeek(earlierWeek), deliveries: [{
    id: "first", productId: wheat.id, quantity: 20,
    dispatchDate: "2026-11-05", arrivalDate: "2026-11-05",
  }] };
  const later = { ...nextWeekShip(wheat, 20), packaging: [{
    id: "pack-later", productId: wheat.id, quantity: 60,
  }] };
  const plans = [earlierShipping, later];
  const { confirmed } = classifyAcrossWeeks(plans);
  assert.equal(confirmed.length, 0,
    "later week packaging cannot fix a previously uncovered dispatch");
});
