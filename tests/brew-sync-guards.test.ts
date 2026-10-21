import test from "node:test";
import assert from "node:assert/strict";
import { mergeBrewSheetEditDelta, persistConfirmedBrewMaterials, shouldAcceptRemoteBrewingExecution } from "../src/SERVICES/brewing/brewSyncGuards";
import type { BrewSyncExecution as BrewExecution } from "../src/SERVICES/brewing/brewSyncGuards";

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


test("approvals for A and B survive close/reopen from canonical Firestore, without certifying C", async () => {
  let remote = base({
    "wp.start": "08:40",
    "materialLot.grain": "lot-A",
  });
  remote.blocks["2"] = { fields: { "mashIn.start": "09:05", "materialLot.grain": "lot-B" } };
  remote.blocks["3"] = { fields: {} };
  const save = async (candidate: BrewExecution) => {
    // Model the acknowledged Firestore write rather than a browser timeout.
    remote = structuredClone(candidate);
  };
  const approvedA = await persistConfirmedBrewMaterials(remote, 1, save);
  assert.equal(approvedA.blocks["1"].fields.materialsConfirmed, "yes");
  assert.equal(approvedA.blocks["2"].fields.materialsConfirmed, undefined);
  const approvedB = await persistConfirmedBrewMaterials(remote, 2, save);
  assert.equal(approvedB.blocks["1"].fields.materialsConfirmed, "yes");
  assert.equal(approvedB.blocks["2"].fields.materialsConfirmed, "yes");
  assert.equal(approvedB.blocks["3"].fields.materialsConfirmed, undefined);

  // A fresh session receives persisted Firestore state, not last visited tab
  // or an old localStorage snapshot that would omit the confirmation.
  const reopened = structuredClone(remote);
  reopened.activeBlockIndex = 2;
  reopened.activeStepIndex = 1;
  assert.equal(reopened.blocks["1"].fields.materialsConfirmed, "yes");
  assert.equal(reopened.blocks["2"].fields.materialsConfirmed, "yes");
  assert.equal(reopened.blocks["1"].fields["materialLot.grain"], "lot-A");
  assert.equal(reopened.blocks["2"].fields["materialLot.grain"], "lot-B");
});

test("the materials-approved marker is never returned before the Firestore promise is acknowledged", async () => {
  const original = base({ "materialLot.grain": "lot-A" });
  let completeWrite: (() => void) | null = null;
  const pendingWrite = new Promise<void>(resolve => { completeWrite = resolve; });
  let finished = false;
  const pending = persistConfirmedBrewMaterials(original, 1, async candidate => {
    assert.equal(candidate.blocks["1"].fields.materialsConfirmed, "yes");
    await pendingWrite;
  }).then(value => {
    finished = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(finished, false, "a pending remote write must not count as approval");
  assert.equal(original.blocks["1"].fields.materialsConfirmed, undefined);
  if (!completeWrite) throw new Error("missing write resolver");
  (completeWrite as () => void)();
  const confirmed = await pending;
  assert.equal(finished, true);
  assert.equal(confirmed.blocks["1"].fields.materialsConfirmed, "yes");
});

test("a rejected Firestore write must not falsely confirm a brew in local state", async () => {
  const original = base({ "materialLot.grain": "lot-A" });
  await assert.rejects(
    persistConfirmedBrewMaterials(original, 1, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(original.blocks["1"].fields.materialsConfirmed, undefined);
  assert.equal(original.blocks["2"].fields.materialsConfirmed, undefined);
});

test("approval cannot accidentally create a nonexistent block or validate navigation", async () => {
  const original = base({ "materialLot.grain": "lot-A" });
  await assert.rejects(
    persistConfirmedBrewMaterials(original, 0, async () => undefined),
    /Invalid brew block/,
  );
  const after = await persistConfirmedBrewMaterials(original, 1, async () => undefined);
  assert.equal(after.activeBlockIndex, original.activeBlockIndex);
  assert.equal(after.activeStepIndex, original.activeStepIndex);
  assert.equal(after.blocks["2"].fields.lrPlato, "9");
});
