// SERVICES/getAllBrews.ts
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
} from "firebase/firestore";
import { db } from "../../firebase";

export type BrewSummary = {
  id: string;
  batchNumber: string;
  beerStyle: string;
  brewDate: string;
};

export type BrewSummaryPage = {
  rows: BrewSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

const BREW_SUMMARY_TTL_MS = 5 * 60 * 1000;
const pageCache = new Map<string, { loadedAt: number; page: BrewSummaryPage }>();
const pendingPages = new Map<string, Promise<BrewSummaryPage>>();

function encodeBrewCursor(value: unknown): string {
  return typeof value === "number"
    ? `n:${value}`
    : `s:${String(value ?? "")}`;
}

function decodeBrewCursor(cursor: string): string | number {
  if (cursor.startsWith("n:")) {
    const value = Number(cursor.slice(2));
    return Number.isFinite(value) ? value : cursor.slice(2);
  }
  return cursor.startsWith("s:") ? cursor.slice(2) : cursor;
}

function copyPage(page: BrewSummaryPage): BrewSummaryPage {
  return {
    rows: page.rows.map((row) => ({ ...row })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getBrewsSummaryPage(
  cursor: string | null = null,
  pageSize = 60,
): Promise<BrewSummaryPage> {
  const safeSize = Math.max(10, Math.min(100, Math.round(pageSize)));
  const key = `${cursor ?? "first"}:${safeSize}`;
  const cached = pageCache.get(key);

  if (cached && Date.now() - cached.loadedAt < BREW_SUMMARY_TTL_MS) {
    return copyPage(cached.page);
  }
  const pending = pendingPages.get(key);
  if (pending) return copyPage(await pending);

  const request = (async () => {
    const constraints = [
      orderBy("batchNumber", "desc"),
      ...(cursor ? [startAfter(decodeBrewCursor(cursor))] : []),
      // Fetch one extra doc so the UI knows whether "load more" is useful.
      limit(safeSize + 1),
    ];
    const snapshot = await getDocs(query(collection(db, "brews"), ...constraints));
    const visible = snapshot.docs.slice(0, safeSize);
    const rows = visible.map((item) => {
      const data = item.data() as Record<string, unknown>;
      return {
        id: item.id,
        batchNumber: String(data.batchNumber ?? item.id),
        beerStyle: String(data.beerStyle ?? ""),
        brewDate: String(data.brewDate ?? ""),
      };
    });
    const hasMore = snapshot.docs.length > safeSize;
    const lastVisibleData = visible.length
      ? (visible[visible.length - 1].data() as Record<string, unknown>)
      : null;
    const page: BrewSummaryPage = {
      rows,
      nextCursor: hasMore && lastVisibleData
        ? encodeBrewCursor(lastVisibleData.batchNumber)
        : null,
      hasMore,
    };
    pageCache.set(key, { loadedAt: Date.now(), page });
    return page;
  })();

  pendingPages.set(key, request);
  try {
    return copyPage(await request);
  } finally {
    pendingPages.delete(key);
  }
}

/** Backwards-compatible first page for callers that only need recent brews. */
export async function getAllBrewsSummary(): Promise<BrewSummary[]> {
  return (await getBrewsSummaryPage(null, 100)).rows;
}


export type BrewPhysicsMetadata = {
  batchNumber: string;
  beerStyle: string;
  brewDate: string;
  tankNumber: number | null;
  beerVolumeLiters: number | null;
};

const physicsMetadataCache = new Map<
  string,
  Promise<BrewPhysicsMetadata | null>
>();

function finitePhysicsNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

/**
 * Development/validation helper. Reads the parent brews/{batch} document once
 * and caches it for the session. V9 production recommendations do not use this.
 */
export async function getBrewPhysicsMetadata(
  batchNumber: string | number,
): Promise<BrewPhysicsMetadata | null> {
  const id = String(batchNumber).replace("#", "").trim();
  if (!id || id.includes("/")) return null;

  const cached = physicsMetadataCache.get(id);
  if (cached) return cached;

  const pending = getDoc(doc(db, "brews", id))
    .then((snapshot) => {
      if (!snapshot.exists()) return null;
      const data = snapshot.data() as Record<string, unknown>;

      const tankNumber =
        finitePhysicsNumber(data.tankNumber) ??
        finitePhysicsNumber(data.tank) ??
        finitePhysicsNumber(data.fermentorNumber);
      const beerVolumeLiters =
        finitePhysicsNumber(data.beerVolume) ??
        finitePhysicsNumber(data.volume) ??
        finitePhysicsNumber(data.beerVolumeLiters);

      return {
        batchNumber: String(data.batchNumber ?? id),
        beerStyle: String(data.beerStyle ?? ""),
        brewDate: String(data.brewDate ?? ""),
        tankNumber,
        beerVolumeLiters,
      };
    })
    .catch((error) => {
      console.warn("V9 validation metadata unavailable", {
        batchNumber: id,
        error,
      });
      return null;
    });

  physicsMetadataCache.set(id, pending);
  return pending;
}
