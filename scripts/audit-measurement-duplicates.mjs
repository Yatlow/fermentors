#!/usr/bin/env node
/**
 * Read-only, bounded Firestore measurement duplicate audit.
 *
 * Example (credentials via GOOGLE_APPLICATION_CREDENTIALS):
 *   FIREBASE_PROJECT_ID=your-project node scripts/audit-measurement-duplicates.mjs --batches 1600,1601
 *
 * This script NEVER writes, deletes, or schedules anything. It reads ONLY the
 * measurement subcollections for explicitly named batches (maximum 10).
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const index = args.indexOf("--batches");
const raw = index >= 0 ? args[index + 1] : "";
const batches = raw.split(",").map(v => v.trim().replace(/^#/, "")).filter(Boolean);
if (!raw || batches.length < 1 || batches.length > 10 ||
    new Set(batches).size !== batches.length ||
    batches.some(v => !/^\d{1,12}$/.test(v))) {
  console.error("Usage: FIREBASE_PROJECT_ID=... node scripts/audit-measurement-duplicates.mjs --batches 1600,1601 (1-10 distinct numeric batches)");
  process.exitCode = 2;
} else if (!process.env.FIREBASE_PROJECT_ID) {
  console.error("Set FIREBASE_PROJECT_ID explicitly; no default project allowed.");
  process.exitCode = 2;
} else {
  initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  const db = getFirestore();
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
  console.log(JSON.stringify({ readonly: true, projectId: process.env.FIREBASE_PROJECT_ID, results: summary }, null, 2));
}
