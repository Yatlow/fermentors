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

const args = process.argv.slice(2);
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
const invalid = malformed || (allBrews === (raw !== null)) ||
  (!allBrews && (batches.length < 1 || batches.length > 10 ||
    new Set(batches).size !== batches.length ||
    batches.some(v => !/^\d{1,12}$/.test(v)))) ||
  (!Number.isSafeInteger(offset) || offset < 0) ||
  (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) ||
  (!allBrews && (offset !== 0 || limit !== 100));
if (invalid) {
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
  const metrics = ["temp", "plato", "pH", "pressure", "carbonation", "notes", "date", "time"];
  const summary = [];
  for (const batch of batches) {
    const docs = await db.collection("brews").doc(batch).collection("measurements").get();
    const byDay = new Map();
    for (const doc of docs.docs) {
      const data = doc.data();
      const idDay = doc.id.match(/^(\d{4}-\d{2}-\d{2})(?:_\d{3,4})?$/)?.[1];
      const sheetDay = String(data.date ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const fieldDay = sheetDay
        ? `${sheetDay[3]}-${sheetDay[2].padStart(2, "0")}-${sheetDay[1].padStart(2, "0")}`
        : null;
      const day = fieldDay || idDay || `unrecognized:${doc.id}`;
      const list = byDay.get(day) || [];
      list.push({ id: doc.id, data, dateMismatch: Boolean(idDay && fieldDay && idDay !== fieldDay) });
      byDay.set(day, list);
    }
    const duplicates = [];
    for (const [day, rows] of byDay.entries()) {
      if (rows.length < 2) continue;
      const conflictingFields = metrics.filter(field => {
        const unique = new Set(rows.map(row => JSON.stringify(row.data[field] ?? null)));
        return unique.size > 1;
      });
      duplicates.push({
        day,
        ids: rows.map(row => row.id),
        differingFields: conflictingFields,
        anyDateMismatch: rows.some(row => row.dateMismatch)
      });
    }
    summary.push({
      batch,
      documentsRead: docs.size,
      duplicateDays: duplicates.length,
      duplicateDocuments: duplicates.reduce((sum, group) => sum + group.ids.length - 1, 0),
      unrecognizedIds: docs.docs.filter(doc => !/^\d{4}-\d{2}-\d{2}_\d{3,4}$/.test(doc.id)).map(doc => doc.id),
      duplicates
    });
  }
  console.log(JSON.stringify({ readonly: true, projectId: process.env.FIREBASE_PROJECT_ID, scope: allBrews ? "brews" : "named-batches", offset: allBrews ? offset : null, limit: allBrews ? limit : null, totalBrews, scannedBrews: batches.length, nextOffset: allBrews && offset + batches.length < totalBrews ? offset + batches.length : null, results: summary }, null, 2));
}
