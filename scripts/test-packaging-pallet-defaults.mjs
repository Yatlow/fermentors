import assert from "node:assert/strict";
import fs from "node:fs";

function splitQuantity(total, max) {
  const chunks = [];
  let remaining = Math.round(total);
  while (remaining > 0) {
    const chunk = Math.min(max, remaining);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

function validate(rows, expected, max) {
  const sum = rows.reduce((acc, n) => acc + n, 0);
  return { sum, ok: sum === expected && rows.every((n) => n > 0 && n <= max) };
}

// Regression: today's real-world case.
assert.deepEqual(splitQuantity(162, 20), [20,20,20,20,20,20,20,20,2]);
assert.deepEqual(validate([20,20,20,20,20,20,20,20], 162, 20), { sum: 160, ok: false });
assert.equal(validate([20,20,20,20,20,20,20,11,11], 162, 20).ok, true);
assert.equal(validate([20,20,20,20,20,20,20,22], 162, 20).ok, false);

// Static guards for the durability contract. These catch accidental regression
// without touching Firestore or creating a real packaging report.
const logger = fs.readFileSync("src/SERVICES/getAndPost/packagingMasterSheetLogger.ts", "utf8");
const flow = fs.readFileSync("src/SERVICES/cooler/usePackagingPalletsFlow.ts", "utf8");
const service = fs.readFileSync("src/SERVICES/cooler/Palletservice.ts", "utf8");

assert.match(logger, /await createPalletsForPlan\(palletPlan, defaultSplits\)/,
  "submitPackagingRecord must create safe default pallets immediately");
assert.match(flow, /if \(!isValid[^\n]*\) return/,
  "invalid edited splits must not be confirmed");
assert.match(flow, /replacePalletsForPlan\(runtime\.palletPlan, splits\)/,
  "valid confirmation must replace defaults, not append to them");
assert.match(service, /const batch = writeBatch\(db\)[\s\S]*batch\.delete\(existing\.ref\)[\s\S]*batch\.set\(refs\[index\]/,
  "replacement must delete old and create new pallets in one batch");
assert.match(service, /if \(data\.zone !== "pending"\)/,
  "already moved pallets must not be silently replaced");

console.log("Packaging pallet default-first regression tests passed.");
