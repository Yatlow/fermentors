import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPreReportedActivePallets, type PreShippedPalletCandidate } from "../src/SERVICES/cooler/preReportedPackagingCoverage";

const time = Date.parse("2026-11-19T09:30:00Z");
const manual: PreShippedPalletCandidate = {
  id: "manual-20", zone: "cooler", itemType: "kegs", beerStyle: "IPA",
  batchNumber: "1617", expiryDateStr: "19/05/2027", quantity: 20,
  createdAtMs: Date.parse("2026-11-19T08:10:00Z"),
};
const params = (candidates: PreShippedPalletCandidate[], preShippedQuantity = 0) => ({
  operationId: "pack-1",
  operationCreatedMs: time,
  operationBatch: "1617",
  itemType: "kegs",
  beerStyle: "IPA",
  expiryDateStr: "19/05/2027",
  tankNumber: 8,
  expectedQuantity: 60,
  preShippedQuantity,
  candidates,
});

test("a manual pallet already placed in the cooler covers a late packaging report", () => {
  assert.deepEqual(matchPreReportedActivePallets(params([manual])),
    { palletIds: ["manual-20"], quantity: 20 });
  // The remaining 40 are split into two 20-keg pallets by the existing flow.
});

test("normalizes #batch IDs and style display casing before matching", () => {
  assert.deepEqual(matchPreReportedActivePallets(params([
    { ...manual, batchNumber: "#1617", beerStyle: "ipa" },
  ])), { palletIds: ["manual-20"], quantity: 20 });
});

test("pending manual stock is linked and counted without generating a duplicate", () => {
  assert.deepEqual(matchPreReportedActivePallets(params([{ ...manual, zone: "pending" }])),
    { palletIds: ["manual-20"], quantity: 20 });
});

test("retry sees exactly the already-linked manual pallet", () => {
  const adopted = { ...manual, packagingOperationId: "pack-1", packagingSource: "manual" };
  assert.deepEqual(matchPreReportedActivePallets(params([adopted])),
    { palletIds: ["manual-20"], quantity: 20 });
});

test("another operation's pallet and unrelated SKU must not count as coverage", () => {
  assert.deepEqual(matchPreReportedActivePallets(params([
    { ...manual, packagingOperationId: "another-operation" },
    { ...manual, id: "other-batch", batchNumber: "1618" },
    { ...manual, id: "other-product", itemType: "crates" },
  ])), { palletIds: [], quantity: 0 });
});

test("unlinked active stock from an older day is ambiguous and blocks new pallets", () => {
  assert.throws(() => matchPreReportedActivePallets(params([
    { ...manual, id: "yesterday", createdAtMs: Date.parse("2026-11-18T08:10:00Z") },
  ])), /עקיבות/);
});

test("unknown or future timestamps fail closed rather than create duplicate inventory", () => {
  assert.throws(() => matchPreReportedActivePallets(params([{ ...manual, createdAtMs: undefined }])),
    /זמן יצירה/);
  assert.throws(() => matchPreReportedActivePallets(params([{ ...manual, createdAtMs: time + 1000 }])),
    /זמן יצירה/);
  assert.throws(() => matchPreReportedActivePallets(params([{
    ...manual, createdAtMs: time - 9 * 60 * 60 * 1000,
  }])), /זמן יצירה/);
});

test("same-day expiry mismatch and tank mismatch must be reviewed", () => {
  assert.throws(() => matchPreReportedActivePallets(params([
    { ...manual, expiryDateStr: "20/05/2027" },
  ])), /עקיבות/);
  assert.throws(() => matchPreReportedActivePallets(params([
    { ...manual, sourceTankNumber: 9 },
  ])), /עקיבות/);
});

test("previously shipped + existing active cannot over-cover the packaging report", () => {
  assert.throws(() => matchPreReportedActivePallets(params([
    manual, { ...manual, id: "manual-30", quantity: 30 },
  ], 20)), /לא נוצר מלאי נוסף/);
  assert.deepEqual(matchPreReportedActivePallets(params([manual], 20)),
    { palletIds: ["manual-20"], quantity: 20 });
});
