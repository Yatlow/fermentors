import test from "node:test";
import assert from "node:assert/strict";
import { mergeBrewSheetEditDelta, shouldAcceptRemoteBrewingExecution } from "../src/SERVICES/brewing/brewSyncGuards";
import type { BrewExecution } from "../src/SERVICES/brewing/brewExecution";

const base = (fields: Record<string,string>, updatedAt = "2026-10-14T09:00:00Z"): BrewExecution => ({
  batchNumber: "1605", activeBlockIndex: 1, activeStepIndex: 2,
  updatedAt, blocks: { "1": { fields }, "2": { fields: { lrPlato: "9" } } },
  reviewedSteps: {},
});

test("remote Firestore value outranks a cached timestamp from navigation", () => {
  const remote = base({ lrPlato: "8.8" }, "2026-10-14T09:00:00Z");
  assert.equal(shouldAcceptRemoteBrewingExecution(remote, 0), true);
});

test("only a real in-session edit shields a pending unsaved draft", () => {
  const remote = base({ lrPlato: "8.8" }, "2026-10-14T09:00:00Z");
  assert.equal(shouldAcceptRemoteBrewingExecution(remote, Date.parse("2026-10-14T09:01:00Z")), false);
  assert.equal(shouldAcceptRemoteBrewingExecution(remote, Date.parse("2026-10-14T08:59:00Z")), true);
});

test("Sheet delta only changes the expected field, preserving later local edits", () => {
  const baseline = base({ lrPlato: "8", mashPh: "5.4", temp: "10" });
  const local = base({ lrPlato: "8", mashPh: "5.2", temp: "10" });
  const delta = base({ lrPlato: "7.8", mashPh: "5.1", temp: "10" });
  const result = mergeBrewSheetEditDelta(local, baseline, delta, "2026-10-14T10:00:00Z");
  assert.equal(result.blocks["1"].fields.lrPlato, "7.8");
  assert.equal(result.blocks["1"].fields.mashPh, "5.2");
  assert.equal(result.blocks["2"].fields.lrPlato, "9");
  assert.equal(result.updatedAt, "2026-10-14T10:00:00Z");
});

test("unmapped or already-applied deltas do not schedule a new save", () => {
  const baseline = base({ lrPlato: "8" });
  assert.equal(mergeBrewSheetEditDelta(baseline, baseline, baseline), baseline);
  const wrongBatch = { ...baseline, batchNumber: "1606" };
  assert.equal(mergeBrewSheetEditDelta(baseline, baseline, wrongBatch), baseline);
});
