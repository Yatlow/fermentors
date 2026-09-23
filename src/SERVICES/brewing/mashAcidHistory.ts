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

const CACHE_PREFIX = "fermentors:brewing:acid-history:v4:";
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

export async function loadMashAcidHistoryPreview(
  style: string,
  currentBatchNumber: string,
  forceRefresh = false,
): Promise<MashAcidHistoryRow[]> {
  const currentBatch = String(currentBatchNumber || "").replace("#", "").trim();

  if (!forceRefresh) {
    const cached = loadCached(style);
    if (cached) {
      return cached.filter(
        (row) => String(row.batchNumber).replace("#", "").trim() !== currentBatch,
      );
    }
  }

  const rows = (await serverLoadBrewAcidHistory(
    style,
    currentBatchNumber,
  )) as MashAcidHistoryRow[];

  const previousRows = rows.filter(
    (row) => String(row.batchNumber).replace("#", "").trim() !== currentBatch,
  );
  saveCached(style, previousRows);
  return previousRows;
}
