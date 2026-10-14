#!/usr/bin/env node
/**
 * Read-only, bounded Firestore measurement duplicate audit.
 *
 * Example (credentials via GOOGLE_APPLICATION_CREDENTIALS):
 *   FIREBASE_PROJECT_ID=your-project node scripts/audit-measurement-duplicates.mjs --batches 1600,1601
 *   FIREBASE_PROJECT_ID=your-project node scripts/audit-measurement-duplicates.mjs --all-brews --offset 0 --limit 100
 *
 * This script NEVER writes, deletes, or schedules anything. It reads ONLY the
 * measurement subcollections for explicitly named batches (maximum 10),
 * or every documented brew in the brews collection, subject to a hard safety cap.
 * It does not use fermentor occupancy to determine scope.
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import assert from "node:assert/strict";


/** Detect equivalent measurement IDs, including historical unpadded HHM. */
function normalizeId(id) {
  const match = String(id).match(/^(\d{4}-\d{2}-\d{2})_(\d{3,4})$/);
  if (!match) return null;
  const clock = match[2].padStart(4, "0");
  const hour = +clock.slice(0, 2), minute = +clock.slice(2);
  if (hour > 23 || minute > 59) return null;
  return { date: match[1], clock, key: match[1] + "_" + clock };
}
function normalizeDate(value) {
  const m = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = +m[1], month = +m[2], year = +m[3];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
}
function normalizeTime(value) {
  const m = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return m[1].padStart(2, "0") + m[2];
}
const metrics = ["temp", "plato", "pH", "pressure", "carbonation", "notes", "date", "time"];
function auditDocs(batch, docs) {
  const byInstant = new Map(), unrecognizedIds = [], metadataMismatches = [];
  const byDay = new Map();
  for (const doc of docs) {
    const id = normalizeId(doc.id);
    const data = doc.data();
    const fieldDate = normalizeDate(data.date), fieldTime = normalizeTime(data.time);
    if (!id) unrecognizedIds.push(doc.id);
    if (id && ((fieldDate && id.date !== fieldDate) || (fieldTime && id.clock !== fieldTime))) {
      metadataMismatches.push({id:doc.id,idInstant:id.key,fieldDate,fieldTime});
    }
    // Only trustworthy IDs define identity. Metadata errors are reported,
    // never silently used to join unrelated documents or to delete data.
    if (!id) continue;
    const arr = byInstant.get(id.key) ?? [];
    arr.push({id:doc.id,data});
    byInstant.set(id.key,arr);
    const times = byDay.get(id.date) ?? new Set();
    times.add(id.clock);
    byDay.set(id.date,times);
  }
  const duplicates = [];
  for (const [instant, rows] of byInstant) {
    if (rows.length < 2) continue;
    duplicates.push({
      instant,
      ids: rows.map(row=>row.id),
      differingFields: metrics.filter(field=>
        new Set(rows.map(row=>JSON.stringify(row.data[field] ?? null))).size > 1)
    });
  }
  return {
    batch, documentsRead:docs.length, duplicateInstants:duplicates.length,
    duplicateDocuments:duplicates.reduce((n,d)=>n+d.ids.length-1,0),
    multipleMeasurementsSameDay:[...byDay].filter(([,times])=>times.size>1).map(([date,times])=>({date,distinctTimes:times.size})),
    unrecognizedIds, metadataMismatches, duplicates
  };
}
function selfTest() {
  const docs = items => items.map(([id,data])=>({id,data:()=>data}));
  const r = auditDocs("test",docs([
    ["2026-10-06_627",{date:"06/10/2026",time:"6:27",temp:10}],
    ["2026-10-06_0627",{date:"06/10/2026",time:"06:27",temp:11}],
    ["2026-10-06_0830",{date:"06/10/2026",time:"08:30",temp:12}],
    ["2026-10-07_1200",{date:"07/10/2026",time:"12:00",temp:13}],
    ["bad-id",{date:"07/10/2026",time:"12:00",temp:14}]
  ]));
  assert.equal(r.duplicateInstants,1);
  assert.equal(r.duplicateDocuments,1);
  assert.deepEqual(r.duplicates[0].ids,["2026-10-06_627","2026-10-06_0627"]);
  assert.deepEqual(r.duplicates[0].differingFields,["temp","time"]);
  assert.equal(r.multipleMeasurementsSameDay.length,1);
  assert.deepEqual(r.unrecognizedIds,["bad-id"]);
  assert.equal(r.metadataMismatches.length,0);
  assert.equal(normalizeId("2026-10-06_2460"),null);
  assert.equal(normalizeDate("31/02/2026"),null);
  console.log("Audit self-test passed.");
}

const args = process.argv.slice(2);
const selfTesting = args.length === 1 && args[0] === "--self-test";
const allBrews = args.includes("--all-brews");
const argValue = flag => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const raw = argValue("--batches");
let batches = raw ? raw.split(",").map(v => v.trim().replace(/^#/, "")).filter(Boolean) : [];
const offset = Number(argValue("--offset") ?? "0");
const limit = Number(argValue("--limit") ?? "100");
const allowed = new Set(["--all-brews", "--batches", "--offset", "--limit"]);
const used = new Set();
let malformed = false;
for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (!allowed.has(token) || used.has(token)) { malformed = true; break; }
  used.add(token);
  if (token !== "--all-brews") {
    if (++i >= args.length || args[i].startsWith("--")) { malformed = true; break; }
  }
}
const invalid = !selfTesting && (malformed || (allBrews === (raw !== null)) ||
  (!allBrews && (batches.length < 1 || batches.length > 10 ||
    new Set(batches).size !== batches.length ||
    batches.some(v => !/^\d{1,12}$/.test(v)))) ||
  (!Number.isSafeInteger(offset) || offset < 0) ||
  (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) ||
  (!allBrews && (offset !== 0 || limit !== 100)));
if (selfTesting) {
  selfTest();
} else if (invalid) {
  console.error("Usage: node scripts/audit-measurement-duplicates.mjs (--all-brews [--offset 0] [--limit 100] | --batches 1600,1601)");
  process.exitCode = 2;
} else if (!process.env.FIREBASE_PROJECT_ID) {
  console.error("Set FIREBASE_PROJECT_ID explicitly; no default project allowed.");
  process.exitCode = 2;
} else {
  initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  const db = getFirestore();
  let totalBrews = null;
  if (allBrews) {
    // Include all brews, regardless of fermentor occupancy. Cap both the
    // work per run and the total number of listed IDs before scanning histories.
    const MAX_BREWS = 1000;
    const refs = await db.collection("brews").listDocuments();
    if (refs.length > MAX_BREWS) {
      console.error("Refusing to audit " + refs.length + " brews (maximum " + MAX_BREWS + ").");
      process.exit(2);
    }
    const allIds = refs.map(ref => ref.id)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    totalBrews = allIds.length;
    batches = allIds.slice(offset, offset + limit);
  }
  const summary = [];
  for (const batch of batches) {
    const docs = await db.collection("brews").doc(batch).collection("measurements").get();
    summary.push(auditDocs(batch, docs.docs));
  }
  console.log(JSON.stringify({
    readonly: true, projectId: process.env.FIREBASE_PROJECT_ID,
    scope: allBrews ? "brews" : "named-batches",
    offset: allBrews ? offset : null, limit: allBrews ? limit : null,
    totalBrews, scannedBrews: batches.length,
    batchesScanned: batches,
    measurementDocumentsRead: summary.reduce((n,r)=>n+r.documentsRead,0),
    nextOffset: allBrews && offset + batches.length < totalBrews ? offset + batches.length : null,
    results: summary
  }, null, 2));
}
