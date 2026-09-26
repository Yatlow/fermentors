import { collection, documentId, onSnapshot, query, where, type Unsubscribe } from "firebase/firestore";
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

function hintsFromData(data: unknown): PlannedBrewHint[] {
  const brews = data && typeof data === "object" && Array.isArray((data as { brews?: unknown[] }).brews)
    ? ((data as { brews: BrewPlanWithMeta[] }).brews)
    : [];
  return brews
    .filter((brew) => !!brew.batchNumber && !!brew.tankId)
    .map((brew) => ({
      batchNumber: String(brew.batchNumber),
      style: String(brew.style || ""),
      tankId: String(brew.tankId || ""),
      date: String(brew.date || ""),
    }));
}

function mergePlannedHints(today: string, groups: PlannedBrewHint[][]): PlannedBrewHint[] {
  const seen = new Set<string>();
  return groups
    .flat()
    .filter((hint) => !hint.date || hint.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.batchNumber) - Number(b.batchNumber))
    .filter((hint) => {
      const key = String(hint.batchNumber).replace("#", "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The brewing screen needs every future planned brew that already has a real
 * tank assignment, not only the current and following week. The queue is keyed
 * by operational week (YYYY-MM-DD), so one bounded collection listener keeps
 * the view live without reading historical planning documents.
 */
export function subscribeCurrentWeekPlannedBrewHints(
  onValue: (result: { weekId: string; hints: PlannedBrewHint[]; available: boolean; fromCache: boolean }) => void,
): Unsubscribe {
  const today = dateKey(new Date());
  const weekId = weekStart(today);
  const plannedQuery = query(
    collection(db, "brewPlanningQueue"),
    where(documentId(), ">=", weekId),
  );

  return onSnapshot(plannedQuery, { includeMetadataChanges: true }, (snapshot) => {
    const groups = snapshot.docs.map((item) => hintsFromData(item.data()));
    onValue({
      weekId,
      hints: mergePlannedHints(today, groups),
      available: true,
      fromCache: snapshot.metadata.fromCache,
    });
  }, (error) => {
    console.warn("Failed loading assigned planned brew queue", error);
    onValue({ weekId, hints: [], available: false, fromCache: false });
  });
}
