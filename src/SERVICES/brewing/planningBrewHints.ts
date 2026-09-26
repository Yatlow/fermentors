import { doc, onSnapshot, type Unsubscribe } from "firebase/firestore";
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

function hintsFromData(data: unknown): PlannedBrewHint[] {
  const brews = data && typeof data === "object" && Array.isArray((data as { brews?: unknown[] }).brews)
    ? ((data as { brews: BrewPlanWithMeta[] }).brews)
    : [];
  return brews
    .filter((brew) => !!brew.batchNumber)
    .map((brew) => ({
      batchNumber: String(brew.batchNumber),
      style: String(brew.style || ""),
      tankId: String(brew.tankId || ""),
      date: String(brew.date || ""),
    }));
}

function mergeWeekHints(today: string, current: PlannedBrewHint[], next: PlannedBrewHint[]): PlannedBrewHint[] {
  const seen = new Set<string>();
  return [...next, ...current]
    .filter((hint) => {
      const key = String(hint.batchNumber).replace("#", "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((hint) => !hint.date || hint.date >= today);
}

export function subscribeCurrentWeekPlannedBrewHints(
  onValue: (result: { weekId: string; hints: PlannedBrewHint[]; available: boolean; fromCache: boolean }) => void,
): Unsubscribe {
  const today = dateKey(new Date());
  const weekId = weekStart(today);
  const nextWeekId = addDays(weekId, 7);
  let current: PlannedBrewHint[] = [];
  let next: PlannedBrewHint[] = [];
  let currentReady = false;
  let nextReady = false;
  let currentCache = true;
  let nextCache = true;

  const emit = () => {
    if (!currentReady && !nextReady) return;
    onValue({
      weekId,
      hints: mergeWeekHints(today, current, next),
      available: true,
      fromCache: currentCache && nextCache,
    });
  };

  const unsubscribeCurrent = onSnapshot(doc(db, "brewPlanningQueue", weekId), { includeMetadataChanges: true }, (snapshot) => {
    current = snapshot.exists() ? hintsFromData(snapshot.data()) : [];
    currentReady = true;
    currentCache = snapshot.metadata.fromCache;
    emit();
  }, (error) => {
    console.warn("Failed loading current planned brew queue", error);
    currentReady = true;
    emit();
  });

  const unsubscribeNext = onSnapshot(doc(db, "brewPlanningQueue", nextWeekId), { includeMetadataChanges: true }, (snapshot) => {
    next = snapshot.exists() ? hintsFromData(snapshot.data()) : [];
    nextReady = true;
    nextCache = snapshot.metadata.fromCache;
    emit();
  }, (error) => {
    console.warn("Failed loading next planned brew queue", error);
    nextReady = true;
    emit();
  });

  return () => {
    unsubscribeCurrent();
    unsubscribeNext();
  };
}
