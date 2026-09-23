import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  setDoc,
  where,
} from "firebase/firestore";
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


function acidStyleAliases(style: string): string[] {
  const key = String(style || "").trim().toLowerCase().replace(/\s+(משולש|כפול|בודד)$/, "");
  if (key === "חיטה" || key === "wheat") return ["חיטה", "wheat"];
  if (key === "פייל" || key === "pale" || key === "pale ale") return ["פייל", "pale", "pale ale"];
  if (key === "הופי" || key === "hoppy") return ["הופי", "hoppy"];
  if (key === "לאגר" || key === "lager") return ["לאגר", "lager"];
  if (key === "סטאוט" || key === "stout") return ["סטאוט", "stout"];
  if (key === "ipa") return ["ipa"];
  return [key];
}
function cacheKey(style: string) {
  return CACHE_PREFIX + acidStyleAliases(style)[0];
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

async function loadFirestoreAcidHistory(
  style: string,
): Promise<MashAcidHistoryRow[]> {
  const snapshot = await getDocs(
    query(
      collection(db, "brewAcidHistory"),
      where("styleKey", "in", acidStyleAliases(style)),
      limit(30),
    ),
  );
  return snapshot.docs
    .map((item) => item.data() as MashAcidHistoryRow & { sortKey?: number })
    .sort((a, b) => Number(b.sortKey || 0) - Number(a.sortKey || 0))
    .slice(0, 9);
}

async function persistLegacyRows(
  style: string,
  rows: MashAcidHistoryRow[],
): Promise<void> {
  const styleKey = acidStyleAliases(style)[0];
  await Promise.all(
    rows.map((row) => {
      const batch = Number(String(row.batchNumber).replace("#", ""));
      const letterRank = { A: 1, B: 2, C: 3 }[row.brewLetter] || 0;
      return setDoc(
        doc(db, "brewAcidHistory", `${row.batchNumber}-${row.brewLetter}`),
        {
          ...row,
          styleKey,
          sortKey: Number.isFinite(batch) ? batch * 10 + letterRank : 0,
          source: "legacy-sheet",
        },
        { merge: true },
      );
    }),
  );
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
    await loadFirestoreAcidHistory(style),
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

  // Migration path: a legacy Sheet is paid for only once. After a successful
  // fallback, persist its compact comparison rows so future opens are a single
  // indexed Firestore query.
  if (legacyRows.length) {
    void persistLegacyRows(style, legacyRows).catch((error) =>
      console.warn("Failed caching legacy acid history in Firestore", error),
    );
  }

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
