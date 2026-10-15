import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product } from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { auditShipmentAvailability } from "../src/SERVICES/planning/shipmentAvailabilityAudit";

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
test("a physical partial pallet counts as one truck pallet", () => {
  assert.equal(auditShipmentAvailability(settings, [pallet("partial", 30)], [week(84)], [], today).length, 0);
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
