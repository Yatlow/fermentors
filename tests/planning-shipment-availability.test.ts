import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { auditShipmentAvailability, newlyWorsenedShipmentShortage } from "../src/SERVICES/planning/shipmentAvailabilityAudit";

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
