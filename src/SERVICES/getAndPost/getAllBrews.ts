// SERVICES/getAllBrews.ts
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";

export type BrewSummary = {
  id: string;
  batchNumber: string;
  beerStyle: string;
  brewDate: string;
};

const BREW_SUMMARY_TTL_MS = 5 * 60 * 1000;
let cachedBrews: BrewSummary[] | null = null;
let cachedAt = 0;
let pendingBrews: Promise<BrewSummary[]> | null = null;

function copyBrews(rows: BrewSummary[]): BrewSummary[] {
  return rows.map((row) => ({ ...row }));
}

export async function getAllBrewsSummary(): Promise<BrewSummary[]> {
  if (cachedBrews && Date.now() - cachedAt < BREW_SUMMARY_TTL_MS) {
    return copyBrews(cachedBrews);
  }

  if (pendingBrews) return copyBrews(await pendingBrews);

  pendingBrews = (async () => {
    const snapshot = await getDocs(collection(db, "brews"));

    const brews: BrewSummary[] = snapshot.docs.map((item) => {
      const data = item.data() as Record<string, unknown>;
      return {
        id: item.id,
        batchNumber: String(data.batchNumber ?? item.id),
        beerStyle: String(data.beerStyle ?? ""),
        brewDate: String(data.brewDate ?? ""),
      };
    });

    // Newest batch first
    brews.sort((a, b) => Number(b.batchNumber) - Number(a.batchNumber));
    cachedBrews = brews;
    cachedAt = Date.now();
    return brews;
  })();

  try {
    return copyBrews(await pendingBrews);
  } finally {
    pendingBrews = null;
  }
}
