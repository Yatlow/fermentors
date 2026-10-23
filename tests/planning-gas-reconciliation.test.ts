import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Exercise the real Apps Script helper instead of copying its date rules into
// another TypeScript implementation. Top-level functions are safe to evaluate:
// actual Firestore/GAS calls occur only when srSaturdayReconcile_ is invoked.
const source = readFileSync(resolve("server/weeklyShipmentReconciliation.js"), "utf8");
const globals: Record<string, unknown> = {};
runInNewContext(source, globals);
const expiry = globals.srExpiry_ as (raw: string) => string;
const eligible = globals.srExpiryEligible_ as (
  pallet: { expiryDateStr: string }, dispatchDate: string,
) => boolean;

test("Saturday GAS parses Israeli expiry dates identically to browser rules", () => {
  assert.equal(expiry("30/10/2026"), "2026-10-30");
  assert.equal(expiry("30/10/26"), "2026-10-30");
  assert.equal(expiry("2026-10-30"), "2026-10-30");
  assert.equal(expiry("31/02/2027"), "");
  assert.equal(expiry("not-a-date"), "");
});

test("Saturday auto-reservation cannot pick stock expiring before departure", () => {
  assert.equal(eligible({ expiryDateStr: "25/10/2026" }, "2026-10-26"), false);
  assert.equal(eligible({ expiryDateStr: "26/10/2026" }, "2026-10-26"), true);
  assert.equal(eligible({ expiryDateStr: "30/10/26" }, "2026-10-26"), true);
  assert.equal(eligible({ expiryDateStr: "unknown" }, "2026-10-26"), false);
});

test("GAS filters both existing auto marks and new FEFO candidates by the dispatch cutoff", () => {
  const body = source.slice(source.indexOf("function srSaturdayReconcile_()"));
  assert.match(body, /var dispatchCutoff = first \? String\(first\.dispatchDate\)/);
  const guards = body.match(/srExpiryEligible_\(p, dispatchCutoff\)/g) ?? [];
  assert.equal(guards.length, 2, "existing marks and new candidate pool both need the dispatch-date guard");
});
