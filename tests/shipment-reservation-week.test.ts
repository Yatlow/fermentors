import { test } from "node:test";
import assert from "node:assert/strict";
import { autoReservationWeek, isDispatchInReservationWeek } from "../src/SERVICES/planning/shipmentReservationWeek";

test("during week 42, week 43 shipment must not reserve any pallets", () => {
  assert.equal(autoReservationWeek("2026-10-11", 13), "2026-10-11");
  assert.equal(isDispatchInReservationWeek("2026-10-18", "2026-10-11", 13), false);
  assert.equal(isDispatchInReservationWeek("2026-10-12", "2026-10-11", 13), true);
});

test("Saturday 20:00 Israel cutover reserves only coming Sunday's shipment week", () => {
  assert.equal(autoReservationWeek("2026-10-17", 19), "2026-10-11");
  assert.equal(autoReservationWeek("2026-10-17", 20), "2026-10-18");
  assert.equal(isDispatchInReservationWeek("2026-10-18", "2026-10-17", 20), true);
  assert.equal(isDispatchInReservationWeek("2026-10-19", "2026-10-17", 20), true);
  assert.equal(isDispatchInReservationWeek("2026-10-26", "2026-10-17", 20), false);
});

test("Sunday transitions automatically to the current week without a stale Saturday override", () => {
  assert.equal(autoReservationWeek("2026-10-18", 0), "2026-10-18");
  assert.equal(isDispatchInReservationWeek("2026-10-25", "2026-10-18", 0), false);
});
