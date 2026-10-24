import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { auditShipmentAvailability, classifyPlanningShortageIncreases, describePlanningShortageIncrease, newlyWorsenedShipmentShortage, newlyWorsenedShipmentShortages } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";

const today = "2026-10-15";
const p: Product = { id: "ipa-crates", sku: "ipa-crates", style: "IPA", type: "crates", monthly: 300, tempo: 0, tempoDate: today, leadDays: 1 };
const settings = { ...defaultSettings(), products: [p] };
const pallet = (id: string, quantity = 84): Pallet => ({ id, quantity, itemType: "crates", beerStyle: "IPA", zone: "cooler", expiryDateStr: "31/12/2026", heightUnits: 1, cell: { side: "right", row: 1, col: 1 }, orderInCell: 0 });
const week = (quantity: number, date = "2026-10-19") => ({ ...emptyWeek("2026-10-18"), deliveries: [{ id: "ship", productId: p.id, quantity, dispatchDate: date, arrivalDate: date }] });

test("a 12-pallet shipment with 10 physical pallets and no packaging reports two missing", () => {
  const issues = auditShipmentAvailability(settings, Array.from({ length: 10 }, (_, i) => pallet(String(i))), [week(12 * 84)], [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].missing, 2);
});
test("a physical partial pallet covers one truck slot but reports the actual unit shortfall", () => {
  const issues = auditShipmentAvailability(settings, [pallet("partial", 30)], [week(84)], [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].missing, 0, "a partial pallet still occupies one place");
  assert.equal(issues[0].missingUnits, 54, "shortfall in sellable crates remains visible");
  assert.equal(issues[0].severity, "partial");
  assert.equal(newlyWorsenedShipmentShortage([], issues), undefined,
    "an explicit partial pallet decision remains permitted, with an advisory");
});
test("completed-before-dispatch packaging covers a missing pallet", () => {
  const plan = { ...week(168), packaging: [{ id: "pack", productId: p.id, tankId: "2", quantity: 84, date: "2026-10-18" }] };
  assert.equal(auditShipmentAvailability(settings, [pallet("one")], [plan], [], today).length, 0);
});
test("packaging after dispatch cannot cover shipment", () => {
  const plan = { ...week(168), packaging: [{ id: "pack", productId: p.id, tankId: "2", quantity: 84, date: "2026-10-20" }] };
  assert.equal(auditShipmentAvailability(settings, [pallet("one")], [plan], [], today)[0].missing, 1);
});
test("past-due unperformed packaging cannot create available pallets", () => {
  const prior = { ...emptyWeek("2026-10-11"), packaging: [{ id: "late", productId: p.id, tankId: "2", quantity: 168, date: "2026-10-12" }] };
  assert.equal(auditShipmentAvailability(settings, [], [prior, week(168)], [], today)[0].missing, 2);
});
test("two future shipments cannot reuse the same physical pallet", () => {
  const second = { ...emptyWeek("2026-10-25"), deliveries: [{ id: "second", productId: p.id, quantity: 84, dispatchDate: "2026-10-26", arrivalDate: "2026-10-26" }] };
  assert.equal(auditShipmentAvailability(settings, [pallet("one")], [week(84), second], [], today)[0].week, "2026-10-25");
});


test("completed same-day shipment is not deducted again from already reduced physical stock", () => {
  const first = week(84, "2026-10-15");
  const later = { ...emptyWeek("2026-10-18"), deliveries: [{ id: "later", productId: p.id, quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" }] };
  const actual = { id: "actual-shipment", date: "2026-10-15", totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 84 }] };
  const issues = auditShipmentAvailability(settings, [pallet("remaining")], [first, later], [], today, [actual]);
  assert.equal(issues.length, 0);
});

test("without actual shipment confirmation, same-day commitment still consumes stock", () => {
  const first = week(84, "2026-10-15");
  const later = { ...emptyWeek("2026-10-18"), deliveries: [{ id: "later", productId: p.id, quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" }] };
  const issues = auditShipmentAvailability(settings, [pallet("remaining")], [first, later], [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].date, "2026-10-19");
});

const laterShipment = () => ({
  ...emptyWeek("2026-10-25"),
  deliveries: [{ id: "week43", productId: p.id, quantity: 84, dispatchDate: "2026-10-26", arrivalDate: "2026-10-26" }],
});
const earlierShipment = () => ({
  ...emptyWeek("2026-10-18"),
  deliveries: [{ id: "week42", productId: p.id, quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" }],
});

test("saving earlier week after later week blocks if it invalidates later shipment", () => {
  const before = auditShipmentAvailability(settings, [pallet("a25")], [laterShipment()], [], today);
  const after = auditShipmentAvailability(settings, [pallet("a25")], [laterShipment(), earlierShipment()], [], today);
  assert.equal(before.length, 0);
  assert.equal(after.length, 1);
  const worsened = newlyWorsenedShipmentShortage(before, after);
  assert.equal(worsened?.week, "2026-10-25");
  assert.equal(worsened?.missing, 1);
});

test("future-week shortage creates an actionable SKU/date/delta warning rather than a forced block", () => {
  const before = auditShipmentAvailability(settings, [pallet("one")], [laterShipment()], [], today);
  const after = auditShipmentAvailability(settings, [pallet("one")],
    [earlierShipment(), laterShipment()], [], today);
  const increases = newlyWorsenedShipmentShortages(before, after);
  assert.equal(increases.length, 1);
  assert.equal(increases[0].issue.week, "2026-10-25");
  assert.equal(increases[0].addedSlots, 1);
  assert.equal(increases[0].addedUnits, 84);
  const decision = classifyPlanningShortageIncreases(increases, "2026-10-18");
  assert.equal(decision.blocking.length, 0);
  assert.equal(decision.confirmable.length, 1, "the planner may explicitly accept a later-week deficit");
  const warning = describePlanningShortageIncrease(decision.confirmable[0], settings.products);
  assert.match(warning, /2026-10-25/);
  assert.match(warning, /2026-10-26/);
  assert.match(warning, /IPA/);
  assert.match(warning, /1 מקומות/);
  assert.match(warning, /84 יחידות/);
});

test("new deficit in current week remains blocking; missing pinned physical pallet cannot be waived", () => {
  const sameWeek = { issue: { week: "2026-10-18", date: "2026-10-19",
    productId: p.id, missing: 1, message: "missing", severity: "blocking" as const },
    addedSlots: 1, addedUnits: 84, totalSlots: 1, totalUnits: 84 };
  const pinnedLater = { issue: { week: "2026-10-25", date: "2026-10-26",
    productId: "pallet:missing-id", missing: 1, message: "pinned missing",
    severity: "blocking" as const },
    addedSlots: 1, addedUnits: 0, totalSlots: 1, totalUnits: 0 };
  const { blocking, confirmable } = classifyPlanningShortageIncreases(
    [sameWeek, pinnedLater], "2026-10-18");
  assert.equal(blocking.length, 2);
  assert.equal(confirmable.length, 0);
});

test("two same-day trucks have one accurate aggregated increase rather than repeated warnings", () => {
  const before = [{ week: "2026-10-25", date: "2026-10-26",
    productId: p.id, missing: 1, missingUnits: 84,
    severity: "blocking" as const, message: "old missing pallet" }];
  const after = [...before, { ...before[0], message: "second truck", missing: 1, missingUnits: 84 }];
  const increases = newlyWorsenedShipmentShortages(before, after);
  assert.equal(increases.length, 1);
  assert.equal(increases[0].addedSlots, 1);
  assert.equal(increases[0].totalSlots, 2);
  assert.equal(increases[0].addedUnits, 84);
  assert.equal(increases[0].totalUnits, 168);
});
 
test("saving earlier week does not block when both shipments have physical coverage", () => {
  const physical = [pallet("a25"), pallet("a26")];
  const before = auditShipmentAvailability(settings, physical, [laterShipment()], [], today);
  const after = auditShipmentAvailability(settings, physical, [laterShipment(), earlierShipment()], [], today);
  assert.equal(newlyWorsenedShipmentShortage(before, after), undefined);
});

test("dated packaging between the earlier and later shipments can cover the later shipment", () => {
  const later = {
    ...laterShipment(),
    packaging: [{ id: "week43-pack", productId: p.id, quantity: 84, date: "2026-10-22" }],
  };
  const before = auditShipmentAvailability(settings, [pallet("a25")], [later], [], today);
  const after = auditShipmentAvailability(settings, [pallet("a25")], [later, earlierShipment()], [], today);
  assert.equal(newlyWorsenedShipmentShortage(before, after), undefined);
});

test("editing earlier week without changing shipments cannot waive a newly worsened later shortage", () => {
  const initial = {
    ...earlierShipment(),
    packaging: [{ id: "week42-pack", productId: p.id, quantity: 84, date: "2026-10-20" }],
  };
  const before = auditShipmentAvailability(settings, [pallet("a25")], [initial, laterShipment()], [], today);
  const changed = { ...initial, packaging: [] };
  const after = auditShipmentAvailability(settings, [pallet("a25")], [changed, laterShipment()], [], today);
  assert.equal(before.length, 0);
  assert.equal(newlyWorsenedShipmentShortage(before, after)?.week, "2026-10-25");
});


test("expired physical stock cannot cover a shipment scheduled after its expiry", () => {
  const delivery = { ...emptyWeek("2026-11-08"), deliveries: [{
    id: "nov-shipment", productId: p.id, quantity: 84,
    dispatchDate: "2026-11-10", arrivalDate: "2026-11-10",
  }] };
  const issues = auditShipmentAvailability(settings, [
    { ...pallet("expired-before-dispatch"), expiryDateStr: "31/10/2026" },
  ], [delivery], [], today);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].date, "2026-11-10");
  assert.equal(issues[0].missing, 1);
  assert.equal(issues[0].severity, "blocking");
});

test("FEFO consumes earlier expiry inventory first, leaving later expiry for a second shipment", () => {
  const earlier = { ...week(84), deliveries: [{ ...week(84).deliveries[0],
    id: "first", dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" }] };
  const later = { ...emptyWeek("2026-10-25"), deliveries: [{
    id: "second", productId: p.id, quantity: 84,
    dispatchDate: "2026-10-26", arrivalDate: "2026-10-26",
  }] };
  const stock = [
    { ...pallet("older"), expiryDateStr: "20/10/2026" },
    { ...pallet("newer"), expiryDateStr: "31/12/2026" },
  ];
  const issues = auditShipmentAvailability(settings, stock, [earlier, later], [], today);
  assert.deepEqual(issues, [], "the first shipment uses the expiring pallet and preserves fresher stock");
});


test("opening stock drops pallets expired before the target week", () => {
  const projected = buildWeekStartProjection({
    settings, pallets: [{ ...pallet("old"), expiryDateStr: "20/10/2026" }],
    plans: [], actuals: [], today, week: "2026-10-25",
  }).get(p.id);
  assert.equal(projected?.breweryUnits, 0);
});

test("week opening FEFO uses a soon-expiring pallet for the prior trip and keeps newer stock", () => {
  const projected = buildWeekStartProjection({
    settings, pallets: [
      { ...pallet("old"), expiryDateStr: "20/10/2026" },
      { ...pallet("newer"), expiryDateStr: "31/12/2026" },
    ], plans: [week(84)], actuals: [], today, week: "2026-10-25",
  }).get(p.id);
  assert.equal(projected?.shipmentsBeforeWeek, 84);
  assert.equal(projected?.breweryUnits, 84, "later week must retain the fresher pallet");
});

test("same-day trucks with the same SKU cannot hide a newly worsened combined shortage", () => {
  const baseline = [
    { week: "2026-10-18", date: "2026-10-19", productId: p.id, missing: 1,
      severity: "blocking" as const, message: "one truck uncovered" },
  ];
  const after = [
    ...baseline,
    { week: "2026-10-18", date: "2026-10-19", productId: p.id, missing: 1,
      severity: "blocking" as const, message: "second truck uncovered" },
  ];
  assert.ok(newlyWorsenedShipmentShortage(baseline, after));
  assert.equal(newlyWorsenedShipmentShortage(after, baseline), undefined);
});

test("the availability audit preserves per-trip deficits even for identical dispatch dates", () => {
  const trucks = { ...week(84), deliveries: [
    { id: "a", truckId: "a", productId: p.id, quantity: 84,
      dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" },
    { id: "b", truckId: "b", productId: p.id, quantity: 84,
      dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" },
  ] };
  const before = auditShipmentAvailability(settings, [pallet("one")], [trucks], [], today);
  const extended = { ...trucks, deliveries: [...trucks.deliveries,
    { id: "c", truckId: "c", productId: p.id, quantity: 84,
      dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" }] };
  const after = auditShipmentAvailability(settings, [pallet("one")], [extended], [], today);
  assert.equal(before.reduce((sum, issue) => sum + issue.missing, 0), 1);
  assert.equal(after.reduce((sum, issue) => sum + issue.missing, 0), 2);
  assert.ok(newlyWorsenedShipmentShortage(before, after));
});
