import { collection, getDocsFromServer, orderBy, query, type QuerySnapshot, type DocumentData } from "firebase/firestore";
import { db } from "../../firebase";
import type { Measurement } from "../cellering/calculateCelleringRecomendations";

type Entry = { data?: Measurement[]; loadedAt: number; pending?: Promise<Measurement[]> };
const cache = new Map<string, Entry>();
const revisions = new Map<string, string>();
let watching = false;
let session = 0;
const FALLBACK_MS = 5 * 60 * 1000;
const keyOf = (value: string | number) => String(value).replace("#", "").trim();
const copy = (rows: Measurement[]) => rows.map(row => ({ ...row }));

/** Call outside React state updaters, from the EXISTING fermentors listener. */
export function observeMeasurementRevisions(snapshot: QuerySnapshot<DocumentData>): void {
  if (snapshot.metadata.fromCache) {
    // Do not trust indefinite data while disconnected or before server confirmation.
    stopMeasurementRevisionTracking();
    return;
  }
  const next = new Map<string, string[]>();
  snapshot.docs.forEach(document => {
    const data = document.data();
    if (data.batchNumber == null) return;
    const id = keyOf(data.batchNumber);
    if (!id) return;
    // A missing revision stays on TTL until the first revised writer runs.
    if (typeof data.measurementsRevision !== "string" || !data.measurementsRevision) return;
    const values = next.get(id) ?? [];
    values.push(JSON.stringify([document.id, data.measurementsRevision, data.currentData]));
    next.set(id, values);
  });
  const fresh = new Map([...next].map(([id, values]) => [id, values.sort().join("|")]));
  new Set([...revisions.keys(), ...fresh.keys()]).forEach(id => {
    if (revisions.get(id) !== fresh.get(id)) cache.delete(id);
  });
  revisions.clear();
  fresh.forEach((value, id) => revisions.set(id, value));
  watching = true;
}

export function stopMeasurementRevisionTracking(): void {
  watching = false;
  revisions.clear();
  cache.clear();
  session++;
}

export function invalidateMeasurementsCache(batchNumber?: string | number): void {
  if (batchNumber === undefined) cache.clear();
  else cache.delete(keyOf(batchNumber));
}

// Compatibility with the previous writer. Invalidate the WHOLE history rather
// than marking a partial local update as the latest version of all history.
export function upsertMeasurementInCache(batchNumber: string | number, _measurement: Measurement): void {
  invalidateMeasurementsCache(batchNumber);
}

export type GetMeasurementsOptions = { forceRefresh?: boolean };
export async function getMeasurementsByBatch(
  batchNumber: string | number, options: GetMeasurementsOptions = {}
): Promise<Measurement[]> {
  const id = keyOf(batchNumber);
  if (!id || id.includes("/")) throw new Error("Invalid batch number");
  if (options.forceRefresh) cache.delete(id);
  const cached = cache.get(id);
  const tracked = watching && revisions.has(id);
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
      const rows = snapshot.docs.map(document => ({ ...document.data(), id: document.id })) as Measurement[];
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
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
