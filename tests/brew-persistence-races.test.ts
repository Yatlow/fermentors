import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeBrewRemotePreservingLocalEdits,
  reconcileBrewStartupFields,
  shouldPersistBrewUnmount,
  hasUnsavedBrewFields,
  type BrewSyncExecution,
} from "../src/SERVICES/brewing/brewSyncGuards";
import { persistBrewBeforeExit } from "../src/SERVICES/brewing/brewExitPersistence";

function execution(block1: Record<string, string>, block2: Record<string, string>): BrewSyncExecution {
  return {
    batchNumber: "1608", activeBlockIndex: 1, activeStepIndex: 1,
    updatedAt: "2026-10-21T07:20:00Z",
    blocks: { "1": { fields: block1 }, "2": { fields: block2 } },
  };
}

test("a newer Sheet/Firestore update to B cannot erase uncommitted A time and temperature", () => {
  const baseline = execution({ "heat2.end": "08:42", "transferLt.start": "08:53", "transferLt.temp": "77.5" },
    { "mashIn.start": "07:20", mashPh: "5.6" });
  const local = execution({ ...baseline.blocks["1"].fields, "transferLt.start": "09:01",
    "transferLt.temp": "78" }, baseline.blocks["2"].fields);
  const remote = execution(baseline.blocks["1"].fields, { ...baseline.blocks["2"].fields, mashPh: "5.63" });
  const merged = mergeBrewRemotePreservingLocalEdits(local, baseline, remote);
  assert.equal(merged.blocks["1"].fields["transferLt.start"], "09:01");
  assert.equal(merged.blocks["1"].fields["transferLt.temp"], "78");
  assert.equal(merged.blocks["2"].fields.mashPh, "5.63");
  assert.equal(merged.activeBlockIndex, 1);
});

test("remote updates win for untouched fields and independent B works while A is dirty", () => {
  const before = execution({ "rest1.start": "07:48" }, { "mashIn.start": "06:50" });
  const local = execution({ "rest1.start": "07:48", "rest1.end": "08:08" },
    before.blocks["2"].fields);
  const changed = execution({ "rest1.start": "07:49" }, { "mashIn.start": "06:55" });
  const merged = mergeBrewRemotePreservingLocalEdits(local, before, changed);
  assert.equal(merged.blocks["1"].fields["rest1.end"], "08:08");
  assert.equal(merged.blocks["1"].fields["rest1.start"], "07:49");
  assert.equal(merged.blocks["2"].fields["mashIn.start"], "06:55");
});

test("silent Sheet recovery fills blanks but does not overwrite recorded mash and lautering times", () => {
  const existing = {
    "mashIn.start": "07:20",
    "rest1.end": "08:08",
    "transferLt.start": "08:53",
    "materialsConfirmed": "yes",
    "__sheetRow.stage.mashIn": "12",
  };
  const sheet = {
    "mashIn.start": "07:10",
    "rest1.end": "08:08",
    "transferLt.start": "08:42",
    "transferLt.temp": "77.5",
    "materialsConfirmed": "",
    "__sheetRow.stage.mashIn": "13",
  };
  const { fields, conflicts } = reconcileBrewStartupFields(existing, sheet);
  assert.equal(fields["mashIn.start"], "07:20");
  assert.equal(fields["transferLt.start"], "08:53");
  assert.equal(fields["transferLt.temp"], "77.5");
  assert.equal(fields["materialsConfirmed"], "yes");
  assert.equal(fields["__sheetRow.stage.mashIn"], "13");
  assert.deepEqual(conflicts.map(c => c.key).sort(), ["mashIn.start", "transferLt.start"]);
});

test("empty legacy Firestore blocks are recovered from the Sheet without manufacturing approval", () => {
  const a = reconcileBrewStartupFields({}, { "mashIn.start": "07:20", "materialsConfirmed": "yes" });
  const b = reconcileBrewStartupFields({}, { "mashIn.start": "08:53" });
  assert.equal(a.fields["mashIn.start"], "07:20");
  assert.equal(a.fields.materialsConfirmed, undefined);
  assert.equal(b.fields["mashIn.start"], "08:53");
});

test("close waits for a queued Sheet write, then uses the latest state for durable Firestore commit", async () => {
  let acknowledgeSheet: (() => void) | undefined;
  const sheetPending = new Promise<void>(resolve => { acknowledgeSheet = resolve; });
  let snapshot = "08:53";
  const order: string[] = [];
  const close = persistBrewBeforeExit(
    () => snapshot,
    [sheetPending],
    value => { order.push("local:" + value); return value; },
    async value => { order.push("firestore:" + value); },
    async value => { order.push("history:" + value); },
  );
  await Promise.resolve();
  assert.deepEqual(order, [], "no close or stale Firestore save before Sheet is written");
  snapshot = "09:01";
  acknowledgeSheet?.();
  await close;
  assert.deepEqual(order, ["local:09:01", "firestore:09:01", "history:09:01"]);
});

test("failed Sheet or Firestore acknowledgments refuse to close the brew form", async () => {
  let firestoreCalled = false;
  await assert.rejects(persistBrewBeforeExit(
    () => "08:53", [Promise.reject(new Error("Sheet offline"))],
    value => value,
    async () => { firestoreCalled = true; },
    async () => undefined,
  ), /Sheet offline/);
  assert.equal(firestoreCalled, false);

  await assert.rejects(persistBrewBeforeExit(
    () => "08:53", [], value => value,
    async () => { throw new Error("Firestore offline"); },
    async () => undefined,
  ), /Firestore offline/);
});

test("app tab unmount flushes ordinary drafts but cannot erase an in-flight A/B material approval", () => {
  assert.equal(shouldPersistBrewUnmount(true, false, false), true);
  assert.equal(shouldPersistBrewUnmount(false, false, false), false);
  assert.equal(shouldPersistBrewUnmount(true, true, false), false);
  assert.equal(shouldPersistBrewUnmount(true, false, true), false);
});

test("opening and browsing a brew never posts unchanged data during startup Sheet read", () => {
  const baseline = execution({ "mashIn.start": "07:20" }, { "mashIn.start": "09:01" });
  const onlyNavigation = { ...baseline, activeBlockIndex: 2, activeStepIndex: 4,
    updatedAt: "2026-10-21T08:55:00Z" };
  assert.equal(hasUnsavedBrewFields(onlyNavigation, baseline), false);
  const actualEdit = execution({ ...baseline.blocks["1"].fields, "rest1.start": "07:48" },
    baseline.blocks["2"].fields);
  assert.equal(hasUnsavedBrewFields(actualEdit, baseline), true);
  assert.equal(hasUnsavedBrewFields(baseline, null), true);
  assert.equal(hasUnsavedBrewFields(execution({}, {}), null), false);
  assert.equal(hasUnsavedBrewFields(
    execution({ "__sheetRow.stage.mashIn": "18" }, {}),
    execution({ "__sheetRow.stage.mashIn": "17" }, {}),
  ), false);
});
