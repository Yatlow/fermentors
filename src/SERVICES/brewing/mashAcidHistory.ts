import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { serverLoadBrewAcidHistory } from "./brewingSheetServer";

export type MashAcidHistoryRow = {
  batchNumber: string;
  brewLetter: "A" | "B" | "C";
  brewDate: string;
  mashPh: string;
  mashVolume: string;
  acidMl: string;
  outToBoilPh: string;
  boilPh: string;
  kettleVolume: string;
  boilAcidMl: string;
  outToFermentorPh: string;
  sheetName: string;
  sheetUrl: string;
};

const CACHE_PREFIX = "fermentors:brewing:acid-history:v5:";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cacheKey(style: string) {
  return CACHE_PREFIX + String(style || "").trim().toLowerCase();
}

function loadCached(style: string): MashAcidHistoryRow[] | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(style));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      savedAt?: number;
      rows?: MashAcidHistoryRow[];
    };
    if (
      !parsed.savedAt ||
      Date.now() - parsed.savedAt > CACHE_TTL_MS ||
      !Array.isArray(parsed.rows)
    ) {
      return null;
    }
    return parsed.rows;
  } catch {
    return null;
  }
}

function saveCached(style: string, rows: MashAcidHistoryRow[]) {
  try {
    window.localStorage.setItem(
      cacheKey(style),
      JSON.stringify({ savedAt: Date.now(), rows }),
    );
  } catch {
    // Local storage is a convenience cache only.
  }
}

function rowFromExecution(
  batchNumber: string,
  brewLetter: "A" | "B" | "C",
  fields: Record<string, string>,
): MashAcidHistoryRow | null {
  const row: MashAcidHistoryRow = {
    batchNumber,
    brewLetter,
    brewDate: String(fields.brewDate || ""),
    mashPh: String(fields.mashPh || ""),
    mashVolume: String(fields.mashVolume || ""),
    acidMl: String(fields.mashAcid85 || ""),
    outToBoilPh: String(fields.outToBoilPh || ""),
    boilPh: String(fields.boilPh || ""),
    kettleVolume: String(fields.kettleVolume || ""),
    boilAcidMl: String(fields.boilAcid85 || ""),
    outToFermentorPh: String(fields.outToFermentorPh || ""),
    sheetName: "",
    sheetUrl: "",
  };
  return [
    row.mashPh,
    row.mashVolume,
    row.acidMl,
    row.outToBoilPh,
    row.boilPh,
    row.kettleVolume,
    row.boilAcidMl,
    row.outToFermentorPh,
  ].some(Boolean)
    ? row
    : null;
}

async function loadFirestoreAcidHistory(
  currentBatchNumber: string,
): Promise<MashAcidHistoryRow[]> {
  const current = Number(String(currentBatchNumber || "").replace("#", ""));
  if (!Number.isFinite(current)) return [];

  // New brewing workflow writes every live brew block to brews/{batch}.
  // Probe a small recent window in parallel; legacy batches simply return no
  // brewingExecution and are filled by the Sheets fallback below.
  const batchNumbers = Array.from({ length: 8 }, (_, index) => current - index)
    .filter((batch) => batch > 0);
  const snapshots = await Promise.all(
    batchNumbers.map((batch) => getDoc(doc(db, "brews", String(batch)))),
  );

  const rows: MashAcidHistoryRow[] = [];
  snapshots.forEach((snapshot, index) => {
    if (!snapshot.exists()) return;
    const execution = snapshot.data()?.brewingExecution as
      | { blocks?: Record<string, { fields?: Record<string, string> }> }
      | undefined;
    if (!execution?.blocks) return;
    const batchNumber = String(batchNumbers[index]);
    (["1", "2", "3"] as const).forEach((blockKey, blockIndex) => {
      const fields = execution.blocks?.[blockKey]?.fields;
      if (!fields) return;
      const row = rowFromExecution(
        batchNumber,
        ["A", "B", "C"][blockIndex] as "A" | "B" | "C",
        fields,
      );
      if (row) rows.push(row);
    });
  });
  return rows;
}

export async function loadMashAcidHistoryPreview(
  style: string,
  currentBatchNumber: string,
  currentBrewLetter: "A" | "B" | "C",
  forceRefresh = false,
): Promise<MashAcidHistoryRow[]> {
  const currentBatch = String(currentBatchNumber || "").replace("#", "").trim();
  const withoutCurrentBrew = (rows: MashAcidHistoryRow[]) =>
    rows.filter(
      (row) =>
        !(
          String(row.batchNumber).replace("#", "").trim() === currentBatch &&
          row.brewLetter === currentBrewLetter
        ),
    );

  if (!forceRefresh) {
    const cached = loadCached(style);
    if (cached) return withoutCurrentBrew(cached);
  }

  const firestoreRows = withoutCurrentBrew(
    await loadFirestoreAcidHistory(currentBatchNumber),
  );

  // Once the recent comparison set exists in Firestore, do not touch Drive.
  // During the migration period only, fall back to legacy Sheets when the new
  // workflow has not yet produced enough useful historical brews.
  if (firestoreRows.length >= 3) {
    const rows = firestoreRows.slice(0, 9);
    saveCached(style, rows);
    return rows;
  }

  const legacyRows = withoutCurrentBrew(
    (await serverLoadBrewAcidHistory(
      style,
      currentBatchNumber,
    )) as MashAcidHistoryRow[],
  );

  const seen = new Set<string>();
  const merged = [...firestoreRows, ...legacyRows].filter((row) => {
    const key = `${row.batchNumber}:${row.brewLetter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 9);

  saveCached(style, merged);
  return merged;
}
