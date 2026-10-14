import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error("FIRESTORE_EMULATOR_HOST is required");
const project = "sheet-sync-integration-test";
const root = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const source = readFileSync(new URL("../server/sheetSyncOutbox.js", import.meta.url), "utf8");
const response = (status, body) => ({
  getResponseCode: () => status,
  getContentText: () => JSON.stringify(body),
});
const request = async (suffix, method = "GET", body) => {
  const r = await fetch(root + suffix, {
    method, headers: { "content-type": "application/json", authorization: "Bearer owner" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
function runtime() {
  const ctx = { console, Date, JSON, Math, Number, Object, String, Array, Error, encodeURIComponent, FIREBASE_PROJECT_ID: project };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx;
}
const fields = {
  requestId: { stringValue: "recovery-test-1" },
  action: { stringValue: "addFermentationMeasurements" },
  state: { stringValue: "pending" },
  attempts: { integerValue: "0" },
  readingsJson: { stringValue: JSON.stringify([{ tankId: "10", batchNumber: "1593", notes: "הורדת שמרים" }]) },
};
const confirmed = { success: true, results: [{ success: true, tankId: "10", result: {
  date: "14/10/2026", time: "10:42", notes: "הורדת שמרים", temperature: 4.1, pressure: 1.2,
} }] };
test("recovery writes real Firestore emulator history before removing job, and is idempotent", async () => {
  const ctx = runtime();
  const jobPath = "/sheetSyncJobs/recovery-test-1";
  const historyPath = "/brews/1593/measurements/2026-10-14_1042";
  await request(jobPath, "PATCH", { fields });
  let job = await request(jobPath);
  assert.equal(job.status, 200, JSON.stringify(job.body));
  // Exercise actual Apps Script Firestore REST payload, not a mocked commit.
  let writes;
  ctx.sheetSyncFetch_ = (url, options) => {
    writes = JSON.parse(options.payload);
    return response(200, {});
  };
  ctx.sheetSyncReconcileMeasurements_(job.body, confirmed);
  assert.equal(writes.writes.length, 1);
  const first = await request(":commit", "POST", writes);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const stored = await request(historyPath);
  assert.equal(stored.status, 200);
  assert.equal(stored.body.fields.notes.stringValue, "הורדת שמרים");
  assert.equal(stored.body.fields.temp.doubleValue, 4.1);
  // Replay is safe: same document ID and same values.
  const replay = await request(":commit", "POST", writes);
  assert.equal(replay.status, 200);
  const storedAgain = await request(historyPath);
  assert.equal(storedAgain.body.fields.notes.stringValue, "הורדת שמרים");
  // Only delete the job after the successful real emulator commits.
  const deletion = await request(jobPath, "DELETE");
  assert.equal(deletion.status, 200);
  assert.equal((await request(jobPath)).status, 404);
});
test("invalid confirmation does not produce a commit or delete the pending job", async () => {
  const ctx = runtime();
  const path = "/sheetSyncJobs/recovery-test-2";
  const invalidJob = { ...fields, requestId: { stringValue: "recovery-test-2" } };
  await request(path, "PATCH", { fields: invalidJob });
  const fetched = await request(path);
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
  const doc = fetched.body;
  let called = false;
  ctx.sheetSyncFetch_ = () => { called = true; throw Error("unexpected write"); };
  assert.throws(() => ctx.sheetSyncReconcileMeasurements_(doc, {
    success: true, results: [{ success: true, tankId: "10" }],
  }), /missing confirmed tank row/);
  assert.equal(called, false);
  assert.equal((await request(path)).status, 200);
});
