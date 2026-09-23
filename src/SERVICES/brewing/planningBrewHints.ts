import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { addDays, dateKey, weekStart } from "../planning/planningEngine";

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

async function loadWeekHints(weekId: string): Promise<{ hints: PlannedBrewHint[]; source: "queue" | "none" }> {
  // Brewing users intentionally read only the approved-user projection.
  // planningWeeks itself is planner-only, so probing it here made a normal
  // employee's planned-brew section depend on a permission-denied fallback.
  let source;
  try {
    source = await getDoc(doc(db, "brewPlanningQueue", weekId));
  } catch (error) {
    // One missing/temporarily unreadable week must not hide the other week.
    // The caller can still render whatever queue data is available.
    console.warn("Failed loading planned brew queue", { weekId, error });
    return { hints: [], source: "none" };
  }

  const brews = source.exists() && Array.isArray(source.data()?.brews)
    ? (source.data().brews as BrewPlanWithMeta[])
    : [];

  const hints = brews
    .filter((brew) => !!brew.batchNumber)
    .map((brew) => ({
      batchNumber: String(brew.batchNumber),
      style: String(brew.style || ""),
      tankId: String(brew.tankId || ""),
      date: String(brew.date || ""),
    }));

  return { hints, source: brews.length ? "queue" : "none" };
}

export async function getCurrentWeekPlannedBrewHints(): Promise<{
  weekId: string;
  hints: PlannedBrewHint[];
  available: boolean;
}> {
  const weekId = weekStart(dateKey(new Date()));
  const nextWeekId = addDays(weekId, 7);

  try {
    const [current, next] = await Promise.all([
      loadWeekHints(weekId),
      loadWeekHints(nextWeekId),
    ]);

    const seen = new Set<string>();
    const hints = [...current.hints, ...next.hints].filter((hint) => {
      const key = String(hint.batchNumber).replace("#", "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { weekId, hints, available: true };
  } catch {
    return { weekId, hints: [], available: false };
  }
}
