import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/calculateWeeklyStyleAverages.js", import.meta.url), "utf8");
const script = source.split("// ============================================================\n// FIRESTORE REST HELPERS")[0];

test("style-average job retains global batchCount and writes unique per-day Plato cohort sizes", () => {
  const writes = [];
  const rows = {
    a: [{ date: "2026-10-16", plato: 8, pH: 4.5 }, { date: "2026-10-16", plato: 7.8 }],
    b: [{ date: "2026-10-16", plato: 9, temp: 20 }],
    c: [{ date: "2026-10-16", pH: 4.7 }],
    d: [{ date: "2026-10-16", plato: "", pH: "" }],
  };
  const properties = new Map();
  const ctx = {
    FIREBASE_PROJECT_ID: "test-project",
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, value),
    }) },
    Logger: { log() {} },
    getAllBrewsFromFirestore: () => Object.keys(rows).map(id => ({
      id, data: { beerStyle: "IPA", brewDate: "2026-10-15" },
    })),
    getMeasurementsForBrew: (_project, id) => rows[id],
    // The production deduper merges identical-day measurements first.
    // Keep the duplicate on purpose here to prove unique batch counts.
    dedupeStyleMeasurements_: (measurements) => measurements,
    parseDateOnly: (raw) => new Date(raw + "T12:00:00Z"),
    differenceInDays: (start, end) => Math.round((end.getTime() - start.getTime()) / 86400000),
    setFirestoreDocument: (_project, key, value) => writes.push({ key, value }),
  };
  vm.runInNewContext(script, ctx);
  const result = ctx.calculateWeeklyStyleAverages(true);
  assert.equal(result.skipped, false);
  assert.equal(writes.length, 1);
  const model = writes[0].value;
  assert.equal(model.batchCount, 4, "existing style-wide batch count stays compatible");
  assert.equal(model.days["1"].batchCount, 3, "only brews with valid metrics on that day count");
  assert.equal(model.days["1"].platoBatchCount, 2, "Plato only: different batches, not repeated readings");
  assert.equal(model.days["1"].platoSampleCount, 3, "observations remain distinct from contributing batches");
  assert.equal(model.days["1"].plato, 8.27);
  assert.equal(model.days["1"].sampleCount, 6);
});
