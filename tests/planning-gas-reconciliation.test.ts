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

test("Saturday GAS validates 12 floor places with shared stack-aware capacity", () => {
  const original = globals.SharedShipmentPicking;
  const observed: number[] = [];
  globals.SharedShipmentPicking = {
    calcTruckSlots: (pallets: unknown[]) => {
      observed.push(pallets.length);
      // Simulate two stackable pallets per floor position.
      return Math.ceil(pallets.length / 2);
    },
  };
  try {
    const canFit = globals.srCanFitInTruck_ as (
      marked: unknown[], proposed: unknown[],
    ) => boolean;
    assert.equal(canFit(Array.from({ length: 11 }, (_, i) => ({ id: i })),
      [{ id: 11 }, { id: 12 }]), true);
    assert.equal(canFit(Array.from({ length: 24 }, (_, i) => ({ id: i })),
      [{ id: 24 }]), false);
    assert.deepEqual(observed, [13, 25], "floor capacity considers existing plus all candidate pallets");
    const body = source.slice(source.indexOf("function srSaturdayReconcile_()"));
    assert.match(body, /srCanFitInTruck_\(prior, o\.selected \|\| \[\]\)/);
  } finally {
    globals.SharedShipmentPicking = original;
  }
});

test("Saturday GAS submits pallet releases and reservations in one atomic guarded commit", () => {
  const previousFetch = globals.srFetch_;
  const previousRoot = globals.srRoot_;
  const requests: Array<{ url: string; method: string; payload: any }> = [];
  globals.srRoot_ = () => "https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents";
  globals.srFetch_ = (url: string, method: string, payload: unknown) => {
    requests.push({ url, method, payload });
    return {};
  };
  try {
    const commit = globals.srCommitMarking_ as (changes: any[], guard: any) => void;
    const root = (globals.srRoot_ as () => string)();
    const pallet = (id: string) => ({ name: root + "/pallets/" + id,
      updateTime: "2026-10-23T00:00:00Z" });
    const guard = { name: root + "/shipmentMarkingGuard/active",
      updateTime: "2026-10-23T00:00:00Z", revision: 6 };
    commit([
      { pallet: pallet("a"), fields: { markedForShipment: false, autoReservationWeek: null } },
      { pallet: pallet("b"), fields: { markedForShipment: true, autoReservationWeek: "2026-10-25" } },
    ], guard);
    assert.equal(requests.length, 1, "partial patch writes must be impossible");
    assert.equal(requests[0].method, "post");
    assert.ok(requests[0].url.endsWith("/documents:commit"));
    assert.equal(requests[0].payload.writes.length, 3);
    assert.equal(requests[0].payload.writes[2].update.fields.revision.integerValue, "7");
    assert.equal(requests[0].payload.writes[2].currentDocument.updateTime, guard.updateTime);
    assert.equal(requests[0].payload.writes[0].currentDocument.updateTime,
      "2026-10-23T00:00:00Z");
    assert.equal(requests[0].payload.writes[1].update.fields.markedForShipment.booleanValue, true);
  } finally {
    globals.srFetch_ = previousFetch;
    globals.srRoot_ = previousRoot;
  }
});

test("Saturday GAS does not issue a write or bump the guard when nothing changes", () => {
  const previousFetch = globals.srFetch_;
  let calls = 0;
  globals.srFetch_ = () => { calls++; return {}; };
  try {
    const commit = globals.srCommitMarking_ as (changes: any[], guard: any) => void;
    commit([], { name: "ignored", revision: 1 });
    assert.equal(calls, 0);
  } finally {
    globals.srFetch_ = previousFetch;
  }
});
