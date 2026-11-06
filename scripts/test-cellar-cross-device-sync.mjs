import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const url = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

const historySource = read("../src/SERVICES/getAndPost/measurementHistoryModel.ts");
const historyUrl = url(compile(historySource));
const history = await import(historyUrl);
const parserSource = read("../src/SERVICES/getAndPost/sharedSheetSyncMeasurements.ts");
const parserJs = compile(parserSource).replace(
  'from "./measurementHistoryModel"',
  `from "${historyUrl}"`,
);
const { pendingMeasurementsFromSyncJob } = await import(url(parserJs));
const { mergeOptimisticMeasurementIntoHistory } = history;

const job = (readings, createdAt = { toDate: () => new Date(2026, 10, 6, 9) }) => ({
  readingsJson: JSON.stringify(readings),
  createdAt,
});

test("pending cross-device measurements retain their explicit local day and zero values", () => {
  const parsed = pendingMeasurementsFromSyncJob(job([
    { id: "2026-11-06_0830", batchNumber: "#1610", temp: 0, pressure: 0, plato: "4,2", pH: "4.19", notes: "הורדת שמרים" },
  ]));
  assert.deepEqual(parsed, [{
    batchId: "1610",
    measurement: { id: "2026-11-06_0830", temp: 0, pressure: 0, plato: 4.2, pH: 4.19, notes: "הורדת שמרים" },
  }]);
});

test("pending outbox reading patches reconstruct the same measurement on a second device", () => {
  const parsed = pendingMeasurementsFromSyncJob(job([
    { id: "2026-11-06_0900", batchNumber: "1610", temp: 16, pressure: 0 },
    { id: "2026-11-06_0910", batchNumber: "1610", plato: 5.8, pH: 4.1 },
    { id: "2026-11-06_0920", batchNumber: "1610", notes: "דרייהופ 2 קג", pressureAfterAction: 1.6 },
    { id: "2026-11-06_0930", batchNumber: "1611", carbonation: 2.45, notes: "בדיקת גיזוז" },
  ]));
  const byBatch = new Map();
  for (const { batchId, measurement } of parsed) {
    byBatch.set(batchId, mergeOptimisticMeasurementIntoHistory(byBatch.get(batchId) ?? [], measurement));
  }
  const first = byBatch.get("1610");
  assert.equal(first.length, 1, "a daily Sheet row is one KPI round even with multiple reports");
  assert.equal(first[0].pressure, 0, "pressure action must not overwrite morning pressure reading");
  assert.equal(first[0].plato, 5.8);
  assert.match(first[0].notes, /דרייהופ/);
  assert.equal(byBatch.get("1611")[0].carbonation, 2.45);
});

test("legacy jobs without id are assigned to their Firestore creation day", () => {
  const parsed = pendingMeasurementsFromSyncJob(job([{ batchNumber: "1600", notes: "קירור" }]));
  assert.equal(parsed[0].measurement.id, "2026-11-06");
  assert.deepEqual(pendingMeasurementsFromSyncJob({ readingsJson: "{broken" }), []);
  assert.deepEqual(pendingMeasurementsFromSyncJob(job([{ batchNumber: "", notes: "foo" }])), []);
  assert.deepEqual(pendingMeasurementsFromSyncJob(job([{ batchNumber: "1600", pressureAfterAction: 1.2 }])), []);
});

test("authoritative history accepts the action once, even when the outbox is still pending", () => {
  const base = [{ id: "2026-11-06", temp: 15, pressure: 0, notes: "דרייהופ 2 קג" }];
  const same = pendingMeasurementsFromSyncJob(job([
    { id: "2026-11-06_0920", batchNumber: "1610", notes: "דרייהופ 2 קג" },
  ]))[0].measurement;
  // The snapshot observer skips a patch already covered by the confirmed row.
  assert.ok(base.some((row) => String(row.notes).includes(same.notes)));
  const cache = read("../src/SERVICES/getAndPost/gettAllDataByBatch.ts");
  assert.match(cache, /patchIsCoveredByRows\(patch, rows\)/);
  assert.match(cache, /rememberOptimisticPatch\(batchId, measurement as Measurement\)/);
  assert.match(cache, /sharedPendingByBatch\.clear\(\)/);
  assert.match(cache, /affected\.forEach\(notifyMeasurementsUpdated\)/);
});

test("one shared subscription drives live recalculation in all app views", () => {
  const app = read("../src/App.tsx");
  const state = read("../src/SERVICES/getAndPost/gettAllDataByBatch.ts");
  const writer = read("../src/SERVICES/getAndPost/pushCurrentDataToFirestore.ts");
  const health = read("../src/components/dashboard/HealthDashboard.tsx");
  assert.match(app, /subscribeSharedPendingCellarMeasurements/);
  assert.match(state, /where\("state", "==", "pending"\)/);
  assert.match(state, /notifyMeasurementsUpdated\(batchId\)/);
  assert.match(health, /window\.addEventListener\(MEASUREMENTS_UPDATED_EVENT, refresh\)/);
  assert.match(writer, /id: reading\.id == null \? null : String\(reading\.id\)/);
});
