from pathlib import Path

path = Path('src/SERVICES/getAndPost/gettAllDataByBatch.ts')
text = path.read_text()

old = 'import { collection, getDocsFromServer, orderBy, query, type QuerySnapshot, type DocumentData } from "firebase/firestore";'
new = 'import { collection, getDocsFromCache, getDocsFromServer, orderBy, query, type QuerySnapshot, type DocumentData } from "firebase/firestore";'
if old not in text:
    raise SystemExit('Firestore import marker not found')
text = text.replace(old, new, 1)

marker = '''const FALLBACK_MS = 5 * 60 * 1000;
const keyOf = (value: string | number) => String(value).replace("#", "").trim();
const copy = (rows: Measurement[]) => rows.map(row => ({ ...row }));
'''
replacement = '''const FALLBACK_MS = 5 * 60 * 1000;
const PERSISTED_REVISION_PREFIX = "fermentors:measurement-cache:v1:";
const keyOf = (value: string | number) => String(value).replace("#", "").trim();
const copy = (rows: Measurement[]) => rows.map(row => ({ ...row }));

type PersistedRevision = { revision: string; count: number };

function persistedRevision(batchId: string): PersistedRevision | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${PERSISTED_REVISION_PREFIX}${batchId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedRevision>;
    return typeof parsed.revision === "string" && Number.isFinite(Number(parsed.count))
      ? { revision: parsed.revision, count: Math.max(0, Number(parsed.count)) }
      : null;
  } catch {
    return null;
  }
}

function rememberPersistedRevision(batchId: string, revision: string | undefined, count: number): void {
  if (typeof window === "undefined" || !revision) return;
  try {
    window.localStorage.setItem(
      `${PERSISTED_REVISION_PREFIX}${batchId}`,
      JSON.stringify({ revision, count: Math.max(0, count) }),
    );
  } catch {
    // Storage can be unavailable in private browsing; server fallback remains safe.
  }
}
'''
if marker not in text:
    raise SystemExit('cache constants marker not found')
text = text.replace(marker, replacement, 1)

marker = '''  if (cached?.data && (tracked || Date.now() - cached.loadedAt < FALLBACK_MS)) return copy(cached.data);
  if (cached?.pending) return copy(await cached.pending);
  const entry: Entry = { loadedAt: 0 };
'''
replacement = '''  if (cached?.data && (tracked || Date.now() - cached.loadedAt < FALLBACK_MS)) return copy(cached.data);
  if (cached?.pending) return copy(await cached.pending);

  // Firestore already persists query results in IndexedDB. Trust that local result
  // only when the fermentor's measurement revision exactly matches the revision
  // remembered after our previous authoritative server fetch.
  const currentRevision = revisions.get(id);
  const persisted = currentRevision ? persistedRevision(id) : null;
  if (!options.forceRefresh && currentRevision && persisted?.revision === currentRevision) {
    try {
      const measurementQuery = query(collection(db, "brews", id, "measurements"), orderBy("date"));
      const localSnapshot = await getDocsFromCache(measurementQuery);
      if (localSnapshot.size === persisted.count) {
        const rawRows = localSnapshot.docs.map(document => ({ ...document.data(), id: document.id })) as Measurement[];
        const rows = applyOptimisticPatches(rawRows, id);
        cache.set(id, { data: rows, loadedAt: Date.now() });
        recordReadAudit("Measurements persistent cache", localSnapshot.size);
        return copy(rows);
      }
    } catch {
      // Missing or evicted local query data: use the server fallback below.
    }
  }

  const entry: Entry = { loadedAt: 0 };
'''
if marker not in text:
    raise SystemExit('getMeasurements cache marker not found')
text = text.replace(marker, replacement, 1)

marker = '''      const rows = applyOptimisticPatches(rawRows, id);
      entry.data = rows;
      entry.loadedAt = Date.now();
      entry.pending = undefined;
'''
replacement = '''      const rows = applyOptimisticPatches(rawRows, id);
      entry.data = rows;
      entry.loadedAt = Date.now();
      entry.pending = undefined;
      rememberPersistedRevision(id, revisions.get(id), snapshot.size);
'''
if marker not in text:
    raise SystemExit('server result marker not found')
text = text.replace(marker, replacement, 1)

path.write_text(text)
