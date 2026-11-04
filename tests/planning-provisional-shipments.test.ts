import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product, type WeekPlan } from "../src/SERVICES/planning/planningEngine";
import { auditShipmentAvailability, classifyPlanningShortageIncreases, newlyWorsenedShipmentShortages } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { confirmableUnpackedShipmentShortages, sameWeekUnscheduledPackagingUnits, weeklyShipmentPackagingUnits, weeklyShipmentPackagingRuns, formatPlannedPackagingDay } from "../src/SERVICES/planning/shipmentProvisionalPlanning";
import { openRuns } from "../src/SERVICES/planning/dailyPlanner";

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

const sameWeekStoutAndWheat = (): WeekPlan => ({
  ...emptyWeek(weekId),
  packaging: [
    { id: "stout-tank-3", productId: stout.id, tankId: "3", tankNumber: "3",
      batchNumber: "1609", date: "2026-11-10", quantity: 131 },
    { id: "wheat-tank-8", productId: wheat.id, tankId: "8", tankNumber: "8",
      batchNumber: "1610", date: "2026-11-12", quantity: 105 },
  ],
  deliveries: [
    { id: "stout-on-monday", truckId: "truck-week46", productId: stout.id,
      dispatchDate: "2026-11-09", arrivalDate: "2026-11-09", quantity: 84 },
    { id: "wheat-on-monday", truckId: "truck-week46", productId: wheat.id,
      dispatchDate: "2026-11-09", arrivalDate: "2026-11-09", quantity: 60 },
  ],
});

const conditional = (plans: WeekPlan[], actuals: Parameters<typeof openRuns>[2] = []) => {
  const originalIssues = auditShipmentAvailability(settings, [], plans, actuals, today);
  const increases = newlyWorsenedShipmentShortages([], originalIssues);
  const approved = confirmableUnpackedShipmentShortages(
    increases, plans, products, actuals, weekId,
    { settings, pallets: [], today, shipments: [] },
  );
  return { originalIssues, increases, approved };
};

test("weekly editor offers stout on Tuesday and wheat on Thursday for the same week, despite Monday truck date", () => {
  const plans = [sameWeekStoutAndWheat()];
  const open = openRuns(plans, products, []);
  assert.equal(weeklyShipmentPackagingUnits(open, weekId, stout.id), 131);
  assert.equal(weeklyShipmentPackagingUnits(open, weekId, wheat.id), 105);
  const { originalIssues, approved } = conditional(plans);
  assert.deepEqual(new Set(approved.map((row) => row.issue.productId)),
    new Set([stout.id, wheat.id]));
  assert.equal(originalIssues.filter((row) => row.severity === "blocking").length, 2,
    "the actual date-based audit MUST still report both Monday trucks as physically short");
  assert.ok(originalIssues.every((row) => row.date === "2026-11-09"));
});

test("late in-week packing never becomes physical stock merely by approving the weekly plan", () => {
  const plan = sameWeekStoutAndWheat();
  const before = auditShipmentAvailability(settings, [], [plan], [], today);
  conditional([plan]);
  const after = auditShipmentAvailability(settings, [], [plan], [], today);
  assert.deepEqual(after, before);
  assert.equal(plan.packaging[0].date, "2026-11-10");
  assert.equal(plan.packaging[1].date, "2026-11-12");
  assert.equal(plan.deliveries![0].dispatchDate, "2026-11-09");
});

test("dated packing after the target week and packing in a later week cannot justify a shipment", () => {
  const afterWeek = weeklyDecision(stout, 131, 84, "2026-11-15");
  assert.equal(weeklyShipmentPackagingUnits(openRuns([afterWeek], products, []), weekId, stout.id), 0);
  assert.equal(conditional([afterWeek]).approved.length, 0);
  const later = { ...emptyWeek("2026-11-15"),
    packaging: [{ id: "later", productId: stout.id, quantity: 131, date: "2026-11-16" }] };
  assert.equal(conditional([nextWeekShipForTest(), later]).approved.length, 0);
});

function nextWeekShipForTest(): WeekPlan {
  const plan = sameWeekStoutAndWheat();
  plan.packaging = [];
  plan.deliveries = [plan.deliveries![0]];
  return plan;
}

test("same-week future packaging cannot cover more physical units than planned", () => {
  const insufficient = weeklyDecision(stout, 30, 84, "2026-11-10");
  assert.equal(weeklyShipmentPackagingUnits(openRuns([insufficient], products, []), weekId, stout.id), 30);
  assert.equal(conditional([insufficient]).approved.length, 0,
    "one partial pallet may occupy a slot but cannot be treated as 84 actual crates");
});

test("two distinct shipment trips cannot both spend the same planned Tuesday packaging", () => {
  const plan = weeklyDecision(stout, 131, 84, "2026-11-10");
  plan.deliveries!.push({
    id: "duplicate", truckId: "truck-b", productId: stout.id, quantity: 84,
    dispatchDate: "2026-11-11", arrivalDate: "2026-11-11",
  });
  assert.equal(conditional([plan]).approved.length, 0);
});

test("already performed packaging is reconciled, not credited again as a provisional plan", () => {
  const plan = weeklyDecision(wheat, 60, 60, "2026-11-12");
  plan.packaging[0].tankId = "8";
  plan.packaging[0].tankNumber = "8";
  plan.packaging[0].batchNumber = "1610";
  const actuals = [{ id: "performed", date: "2026-11-04", tankNumber: "8",
    batchNumber: "1610", beerStyle: "חיטה", packagingType: "kegs", quantity: 60 }];
  assert.equal(weeklyShipmentPackagingUnits(openRuns([plan], products, actuals), weekId, wheat.id), 0);
  assert.equal(conditional([plan], actuals).approved.length, 0);
});

test("known missing or wrong SKU packing remains a hard block even in the edited week", () => {
  const plan = weeklyDecision(stout, 0, 84, "2026-11-10");
  plan.packaging.push({ id: "other-sku", productId: wheat.id,
    date: "2026-11-12", quantity: 105 });
  assert.equal(conditional([plan]).approved.length, 0);
});

test("show the actual packaging weekdays to the shipment planner, not generic week labels", () => {
  assert.equal(formatPlannedPackagingDay("2026-11-10"), "יום שלישי 10/11/2026");
  assert.equal(formatPlannedPackagingDay("2026-11-12"), "יום חמישי 12/11/2026");
  assert.equal(formatPlannedPackagingDay(), "טרם נקבע יום אריזה");
  const rows = weeklyShipmentPackagingRuns(openRuns([sameWeekStoutAndWheat()], products, []), weekId, stout.id);
  assert.deepEqual(rows.map((row) => [row.tankNumber, row.remaining, formatPlannedPackagingDay(row.date)]),
    [["3", 131, "יום שלישי 10/11/2026"]]);
});
