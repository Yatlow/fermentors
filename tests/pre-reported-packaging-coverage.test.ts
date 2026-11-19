import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPreReportedShippedPallets } from "../src/SERVICES/cooler/preReportedPackagingCoverage";

const opTime = Date.parse("2026-11-19T09:30:00Z");
const candidate = {
  id: "sent-1", zone: "shipped", itemType: "kegs", beerStyle: "IPA",
  batchNumber: "1603", expiryDateStr: "19/05/2027", quantity: 20,
  createdAtMs: Date.parse("2026-11-19T08:10:00Z"),
  shippedAtMs: Date.parse("2026-11-19T08:50:00Z"),
};
const options = (candidates: Array<typeof candidate>) => ({
  operationCreatedMs: opTime, operationBatch: "1603", beerStyle: "IPA",
  itemType: "kegs", expiryDateStr: "19/05/2027", tankNumber: 4,
  expectedQuantity: 40, candidates,
});

test("pre-report dispatched pallet counts toward later packaging, without rewriting history", () => {
  assert.deepEqual(matchPreReportedShippedPallets(options([candidate])), {
    palletIds: ["sent-1"], quantity: 20,
  });
});
test("earlier-day stock cannot be automatically claimed as a fresh packaging batch", () => {
  const older = { ...candidate, id: "old-stock", createdAtMs: Date.parse("2026-11-18T08:10:00Z") };
  assert.deepEqual(matchPreReportedShippedPallets(options([older])), { palletIds: [], quantity: 0 });
});
test("different lot, product type, or linked previous operation never covers this run", () => {
  const otherBatch = { ...candidate, batchNumber: "1604" };
  const otherType = { ...candidate, itemType: "crates" };
  const linked = { ...candidate, packagingOperationId: "previous-run" };
  assert.deepEqual(matchPreReportedShippedPallets(options([otherBatch, otherType, linked])), {
    palletIds: [], quantity: 0,
  });
});
test("conflicting expiry and over-coverage block automatic pallet creation", () => {
  assert.throws(() => matchPreReportedShippedPallets(options([
    { ...candidate, expiryDateStr: "18/05/2027" },
  ])), /עקיבות/);
  assert.throws(() => matchPreReportedShippedPallets({
    ...options([candidate, { ...candidate, id: "sent-2", quantity: 30 }]),
  }), /לא נוצר מלאי נוסף/);
});
