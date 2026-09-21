import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { dateKey, weekStart } from "../planning/planningEngine";

export type PlannedBrewHint = {
  batchNumber: string;
  style: string;
  tankId: string;
  date: string;
};

type BrewPlanWithMeta = {
  batchNumber?: string;
  style?: string;
  tankId?: string;
  date?: string;
};

export async function getCurrentWeekPlannedBrewHints(): Promise<{
  weekId: string;
  hints: PlannedBrewHint[];
  available: boolean;
}> {
  const weekId = weekStart(dateKey(new Date()));

  try {
    const snapshot = await getDoc(doc(db, "planningWeeks", weekId));
    if (!snapshot.exists()) {
      return { weekId, hints: [], available: true };
    }

    const brews = Array.isArray(snapshot.data()?.brews)
      ? (snapshot.data().brews as BrewPlanWithMeta[])
      : [];

    return {
      weekId,
      available: true,
      hints: brews
        .filter((brew) => !!brew.batchNumber)
        .map((brew) => ({
          batchNumber: String(brew.batchNumber),
          style: String(brew.style || ""),
          tankId: String(brew.tankId || ""),
          date: String(brew.date || ""),
        })),
    };
  } catch {
    // planningWeeks is intentionally planner/admin-only today.
    // Brewing UI treats this as an optional hint until a small read projection exists.
    return { weekId, hints: [], available: false };
  }
}
