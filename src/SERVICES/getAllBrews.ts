// SERVICES/getAllBrews.ts
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase";

export type BrewSummary = {
  id: string;
  batchNumber: string;
  beerStyle: string;
  brewDate: string;
};

export async function getAllBrewsSummary(): Promise<BrewSummary[]> {
  const snapshot = await getDocs(collection(db, "brews"));

  const brews: BrewSummary[] = snapshot.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      batchNumber: String(data.batchNumber ?? doc.id),
      beerStyle: String(data.beerStyle ?? ""),
      brewDate: String(data.brewDate ?? ""),
    };
  });

  // Newest batch first
  brews.sort((a, b) => Number(b.batchNumber) - Number(a.batchNumber));

  return brews;
}