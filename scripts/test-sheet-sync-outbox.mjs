import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../server/sheetSyncOutbox.js", import.meta.url), "utf8");

function createRuntime() {
  const context = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    Array,
    Error,
    encodeURIComponent,
    POST_IDEMPOTENCY_IN_PROGRESS_TTL_MS: 60_000,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "sheetSyncOutbox.js" });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function job({ id = "job-1", requestId = "req-1", attempts = 0 } = {}) {
  return {
    name: `projects/test/databases/(default)/documents/sheetSyncJobs/${id}`,
    fields: {
      requestId: { stringValue: requestId },
      attempts: { integerValue: String(attempts) },
    },
  };
}

function installProcessMocks(context, options = {}) {
  const deleted = [];
  const marked = [];
  const runCalls = [];

  context.sheetSyncPendingJobs_ = () => options.jobs ?? [job()];
  context.postIdempotencyKey_ = (_action, requestId) => `key:${requestId}`;
  context.postReadIdempotencyRecord_ = () => options.existing ?? null;
  context.sheetSyncSanitizedReadings_ = () => {
    if (options.sanitizeError) throw options.sanitizeError;
    return options.readings ?? [{ tankId: "10", notes: "קירור" }];
  };
  context.runPostActionIdempotently_ = (payload) => {
    runCalls.push(payload);
    if (options.runError) throw options.runError;
    return options.runResult ?? { success: true, results: [{ success: true }] };
  };
  context.sheetSyncDeleteJob_ = (id) => deleted.push(id);
  context.sheetSyncMarkJob_ = (id, state, attempts, error) => {
    marked.push({ id, state, attempts, error: String(error) });
  };

  return { deleted, marked, runCalls };
}

test("normalizes batch identifiers before comparing jobs to live tanks", () => {
  const context = createRuntime();
  assert.equal(context.sheetSyncNormalizeBatch_(" #1593 "), "1593");
  assert.equal(context.sheetSyncNormalizeBatch_(1593), "1593");
  assert.equal(context.sheetSyncNormalizeBatch_(null), "");
});

test("treats only complete successful envelopes as successful", () => {
  const context = createRuntime();
  assert.equal(context.sheetSyncResponseSucceeded_({ success: true }), true);
  assert.equal(
    context.sheetSyncResponseSucceeded_({ success: true, results: [{ success: true }, { success: true }] }),
    true,
  );
  assert.equal(
    context.sheetSyncResponseSucceeded_({ success: true, results: [{ success: true }, { success: false }] }),
    false,
  );
  assert.equal(context.sheetSyncResponseSucceeded_({ success: false }), false);
  assert.equal(context.sheetSyncResponseSucceeded_(null), false);
});

test("completed idempotent requests are confirmed without writing to Sheets again", () => {
  const context = createRuntime();
  const mocks = installProcessMocks(context, {
    existing: { state: "done", response: { success: true, results: [{ success: true }] } },
  });

  const stats = context.processPendingSheetSyncJobs_();

  assert.deepEqual(plain(stats), { found: 1, completed: 1, failed: 0, deferred: 0 });
  assert.deepEqual(mocks.deleted, ["job-1"]);
  assert.equal(mocks.runCalls.length, 0);
  assert.equal(mocks.marked.length, 0);
});

test("recent in-progress idempotency records are deferred instead of duplicated", () => {
  const context = createRuntime();
  const mocks = installProcessMocks(context, {
    existing: { state: "in_progress", startedAt: Date.now() },
  });

  const stats = context.processPendingSheetSyncJobs_();

  assert.deepEqual(plain(stats), { found: 1, completed: 0, failed: 0, deferred: 1 });
  assert.equal(mocks.runCalls.length, 0);
  assert.equal(mocks.deleted.length, 0);
  assert.equal(mocks.marked.length, 0);
});

test("pending jobs retry with the original requestId and are removed after success", () => {
  const context = createRuntime();
  const mocks = installProcessMocks(context);

  const stats = context.processPendingSheetSyncJobs_();

  assert.deepEqual(plain(stats), { found: 1, completed: 1, failed: 0, deferred: 0 });
  assert.equal(mocks.runCalls.length, 1);
  assert.equal(mocks.runCalls[0].requestId, "req-1");
  assert.equal(mocks.runCalls[0].action, "addFermentationMeasurements");
  assert.deepEqual(mocks.deleted, ["job-1"]);
});

test("transient failures stay pending until the retry budget is exhausted", () => {
  const context = createRuntime();
  const mocks = installProcessMocks(context, {
    sanitizeError: new Error("temporary network failure"),
  });

  const stats = context.processPendingSheetSyncJobs_();

  assert.deepEqual(plain(stats), { found: 1, completed: 0, failed: 0, deferred: 1 });
  assert.equal(mocks.marked.length, 1);
  assert.equal(mocks.marked[0].state, "pending");
  assert.equal(mocks.marked[0].attempts, 1);
});

test("fifth transient failure becomes failed instead of retrying forever", () => {
  const context = createRuntime();
  const mocks = installProcessMocks(context, {
    jobs: [job({ attempts: 4 })],
    sanitizeError: new Error("still unavailable"),
  });

  const stats = context.processPendingSheetSyncJobs_();

  assert.deepEqual(plain(stats), { found: 1, completed: 0, failed: 1, deferred: 0 });
  assert.equal(mocks.marked[0].state, "failed");
  assert.equal(mocks.marked[0].attempts, 5);
});

test("terminal safety failures are failed immediately", () => {
  const context = createRuntime();
  const terminal = new Error("tank changed batch");
  terminal.sheetSyncTerminal = true;
  const mocks = installProcessMocks(context, { sanitizeError: terminal });

  const stats = context.processPendingSheetSyncJobs_();

  assert.deepEqual(plain(stats), { found: 1, completed: 0, failed: 1, deferred: 0 });
  assert.equal(mocks.marked[0].state, "failed");
  assert.equal(mocks.marked[0].attempts, 1);
});
