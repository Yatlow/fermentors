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

    // If the same future batch number exists in both week projections, the
    // later week is authoritative. This can happen when an older current-week
    // queue still contains stale identities from before a brew was completed.
    // Iterate next week first so stale current-week metadata cannot mask the
    // actual upcoming brew (style/tank/date).
    const seen = new Set<string>();
    const hints = [...next.hints, ...current.hints]
      .filter((hint) => {
        const key = String(hint.batchNumber).replace("#", "").trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      // A planned-brew card is actionable only from today onward. Historical
      // current-week rows belong to planning history/actuals and must never be
      // offered as a new brew, even if a stale queue document still contains
      // them. This also makes old queue pollution harmless without mutating a
      // closed planning week.
      .filter((hint) => !hint.date || hint.date >= today);

    return { weekId, hints, available: true };
  } catch {
    return { weekId, hints: [], available: false };
  }
}
