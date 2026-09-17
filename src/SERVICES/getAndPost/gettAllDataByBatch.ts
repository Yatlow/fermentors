import { collection, getDocsFromServer, orderBy, query, type QuerySnapshot, type DocumentData } from "firebase/firestore";
import { db } from "../../firebase";
import type { Measurement } from "../cellering/calculateCelleringRecomendations";
import {
  collapseMeasurementsToLatestPerDay,
  measurementDayKeyFromId,
  mergeOptimisticMeasurementIntoHistory,
} from "./measurementHistoryModel";

type Entry = { data?: Measurement[]; loadedAt: number; pending?: Promise<Measurement[]> };
const cache = new Map<string, Entry>();
const revisions = new Map<string, string>();
const embeddedBatches = new Set<string>();
const optimisticByBatch = new Map<string, Map<string, Measurement>>();
let watching = false;
let session = 0;
const FALLBACK_MS = 5 * 60 * 1000;
const keyOf = (value: string | number) => String(value).replace("#", "").trim();
const copy = (rows: Measurement[]) => rows.map(row => ({ ...row }));

export const MEASUREMENTS_UPDATED_EVENT = "fermentors:measurements-updated";

export function notifyMeasurementsUpdated(batchNumber: string | number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MEASUREMENTS_UPDATED_EVENT, {
    detail: { batchNumber: keyOf(batchNumber) },
  }));
}

function patchesFor(batchId: string): Measurement[] {
  return [...(optimisticByBatch.get(batchId)?.values() ?? [])];
}

function applyOptimisticPatches(rows: Measurement[], batchId: string): Measurement[] {
  return patchesFor(batchId).reduce(
    (current, patch) => mergeOptimisticMeasurementIntoHistory(current, patch),
    collapseMeasurementsToLatestPerDay(rows)
  );
}

function embeddedMeasurementsFromFermentor(
  data: DocumentData,
  batchId: string,
): Measurement[] | null {
  const rawState = data.cellarState;
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) return null;

  const state = rawState as {
    batchNumber?: unknown;
    measurements?: unknown;
  };
  const stateBatch = keyOf(String(state.batchNumber ?? batchId));
  if (stateBatch !== batchId) return null;

  const rawMeasurements = state.measurements;
  if (!rawMeasurements || typeof rawMeasurements !== "object" || Array.isArray(rawMeasurements)) {
    return [];
  }

  const rows = Object.entries(rawMeasurements)
    .map(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const measurement = value as Record<string, unknown>;
      return {
        ...measurement,
        id: measurement.id ?? id,
      } as Measurement;
    })
    .filter((row): row is Measurement => row !== null);

  return collapseMeasurementsToLatestPerDay(rows);
}

const PATCH_FIELDS = ["temp", "plato", "pH", "pressure", "carbonation", "notes"] as const;

function patchIsCoveredByRows(patch: Measurement, rows: Measurement[]): boolean {
  const day = measurementDayKeyFromId(patch.id);
  if (!day) return false;

  const row = [...rows]
    .reverse()
    .find((candidate) => measurementDayKeyFromId(candidate.id) === day);
  if (!row) return false;

  return PATCH_FIELDS.every((field) => {
    const patchValue = patch[field];
    if (patchValue === undefined || patchValue === null || patchValue === "") return true;

    const rowValue = row[field];
    if (field === "notes") {
      const expected = String(patchValue).trim();
      return expected === "" || String(rowValue ?? "").includes(expected);
    }

    const expected = Number(patchValue);
    const actual = Number(rowValue);
    return Number.isFinite(expected) && Number.isFinite(actual) && expected === actual;
  });
}

function dropCoveredOptimisticPatches(batchId: string, rows: Measurement[]): void {
  const byDay = optimisticByBatch.get(batchId);
  if (!byDay) return;

  byDay.forEach((patch, day) => {
    if (patchIsCoveredByRows(patch, rows)) byDay.delete(day);
  });

  if (byDay.size === 0) optimisticByBatch.delete(batchId);
}

/**
 * App-originated cellar actions should affect the index immediately, before the
 * next Apps Script polling cycle. Keep the optimistic overlay in memory only:
 * Firestore/Sheets remain authoritative and we do not create a second document
 * id when today's Sheet row already has an earlier time.
 */
export function applyOptimisticMeasurementUpdate(
  batchNumber: string | number,
  measurement: Measurement
): void {
  const batchId = keyOf(batchNumber);
  const day = measurementDayKeyFromId(measurement.id);
  if (!batchId || !day) return;

  let byDay = optimisticByBatch.get(batchId);
  if (!byDay) {
    byDay = new Map<string, Measurement>();
    optimisticByBatch.set(batchId, byDay);
  }

  const previous = byDay.get(day);
  const mergedPatch = previous
    ? mergeOptimisticMeasurementIntoHistory([previous], measurement)[0]
    : measurement;
  byDay.set(day, mergedPatch);

  const cached = cache.get(batchId);
  if (cached?.data) {
    cached.data = mergeOptimisticMeasurementIntoHistory(cached.data, measurement);
  }

  notifyMeasurementsUpdated(batchId);
}

/** Call outside React state updaters, from the EXISTING fermentors listener. */
export function observeMeasurementRevisions(snapshot: QuerySnapshot<DocumentData>): void {
  if (snapshot.metadata.fromCache) {
    // A temporary offline/cache-only snapshot must not destroy all measurement
    // histories. Mobile Safari can move between cache/server snapshots while the
    // app remains open; clearing here caused every active batch to be downloaded
    // again when connectivity returned. Keep the last server revisions + cache
    // and reconcile only when the next server-confirmed snapshot arrives.
    return;
  }

  const next = new Map<string, string[]>();
  const nextEmbedded = new Map<string, Measurement[]>();

  snapshot.docs.forEach(document => {
    const data = document.data();
    if (data.batchNumber == null) return;
    const id = keyOf(data.batchNumber);
    if (!id) return;

    const embedded = embeddedMeasurementsFromFermentor(data, id);
    if (embedded !== null) {
      const previous = nextEmbedded.get(id);
      if (!previous || embedded.length >= previous.length) {
        nextEmbedded.set(id, embedded);
      }
    }

    // measurementsRevision is the authoritative signal that measurement history
    // changed. currentData changes frequently for unrelated tank updates and must
    // not invalidate/re-download the complete measurement history.
    if (typeof data.measurementsRevision !== "string" || !data.measurementsRevision) return;
    const values = next.get(id) ?? [];
    values.push(JSON.stringify([document.id, data.measurementsRevision]));
    next.set(id, values);
  });

  const fresh = new Map([...next].map(([id, values]) => [id, values.sort().join("|")]));
  new Set([...revisions.keys(), ...fresh.keys()]).forEach(id => {
    if (revisions.get(id) !== fresh.get(id)) {
      cache.delete(id);
      // Keep a local/authoritative same-day overlay until the compact cellarState
      // actually contains it. A revision can arrive a moment before the next
      // fermentor sync writes the embedded history.
    }
  });
  revisions.clear();
  fresh.forEach((value, id) => revisions.set(id, value));

  embeddedBatches.clear();
  nextEmbedded.forEach((baseRows, id) => {
    embeddedBatches.add(id);
    dropCoveredOptimisticPatches(id, baseRows);
    cache.set(id, {
      data: applyOptimisticPatches(baseRows, id),
      loadedAt: Date.now(),
    });
  });

  watching = true;
}

export function stopMeasurementRevisionTracking(): void {
  watching = false;
  revisions.clear();
  embeddedBatches.clear();
  cache.clear();
  optimisticByBatch.clear();
  session++;
}

export function invalidateMeasurementsCache(batchNumber?: string | number): void {
  if (batchNumber === undefined) cache.clear();
  else cache.delete(keyOf(batchNumber));
}

// The authoritative Sheet result now exists in Firestore, but the compact
// cellarState on the fermentor can lag it by one sync cycle. Keep that exact
// merged row as an overlay until observeMeasurementRevisions sees the same data
// embedded in cellarState. This avoids a full-history read during that window.
export function upsertMeasurementInCache(batchNumber: string | number, measurement: Measurement): void {
  applyOptimisticMeasurementUpdate(batchNumber, measurement);
}

export type GetMeasurementsOptions = { forceRefresh?: boolean };
export async function getMeasurementsByBatch(
  batchNumber: string | number, options: GetMeasurementsOptions = {}
): Promise<Measurement[]> {
  const id = keyOf(batchNumber);
  if (!id || id.includes("/")) throw new Error("Invalid batch number");
  if (options.forceRefresh) cache.delete(id);
  const cached = cache.get(id);
  const tracked = watching && (revisions.has(id) || embeddedBatches.has(id));
  if (cached?.data && (tracked || Date.now() - cached.loadedAt < FALLBACK_MS)) return copy(cached.data);
  if (cached?.pending) return copy(await cached.pending);
  const entry: Entry = { loadedAt: 0 };
  const startedSession = session;
  cache.set(id, entry);
  entry.pending = (async () => {
    try {
      const snapshot = await getDocsFromServer(query(collection(db, "brews", id, "measurements"), orderBy("date")));
      if (startedSession !== session) throw new Error("Measurement session changed; please retry");
      // An invalidation or newer request won the race. Never return old results.
      if (cache.get(id) !== entry) return getMeasurementsByBatch(id);
      const rawRows = snapshot.docs.map(document => ({ ...document.data(), id: document.id })) as Measurement[];
      const rows = applyOptimisticPatches(rawRows, id);
      entry.data = rows;
      entry.loadedAt = Date.now();
      entry.pending = undefined;
      // Bound memory for long-running sessions; evicted histories reload on demand.
      if (cache.size > 100) {
        const oldest = [...cache.keys()].find(key => key !== id && !cache.get(key)?.pending);
        if (oldest) cache.delete(oldest);
      }
      return rows;
    } catch (error) {
      if (cache.get(id) === entry) cache.delete(id);
      throw error;
    }
  })();
  return copy(await entry.pending);
}
