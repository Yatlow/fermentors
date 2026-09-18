// SERVICES/getAllBrews.ts
import {
  collection,
  documentId,
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
      orderBy(documentId(), "desc"),
      ...(cursor ? [startAfter(cursor)] : []),
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
    const page: BrewSummaryPage = {
      rows,
      nextCursor: hasMore && visible.length ? visible[visible.length - 1].id : null,
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
