import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../../firebase";
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

async function loadWeekHints(weekId: string): Promise<PlannedBrewHint[]> {
  const queueRef = doc(db, "brewPlanningQueue", weekId);
  let source = await getDoc(queueRef);
  let plannerFallback: BrewPlanWithMeta[] | null = null;

  if (auth.currentUser) {
    try {
      const planningSnapshot = await getDoc(doc(db, "planningWeeks", weekId));
      if (planningSnapshot.exists()) {
        const rawBrews = Array.isArray(planningSnapshot.data()?.brews)
          ? (planningSnapshot.data().brews as BrewPlanWithMeta[])
          : [];
        plannerFallback = rawBrews;
        const projectedBrews = rawBrews
          .filter((brew) => !!brew.batchNumber)
          .map((brew) => ({
            id: String((brew as BrewPlanWithMeta & { id?: string }).id || ""),
            batchNumber: String(brew.batchNumber),
            style: String(brew.style || ""),
            tankId: String(brew.tankId || ""),
            date: String(brew.date || ""),
          }));

        if (!source.exists()) try {
          await setDoc(queueRef, {
            id: weekId,
            revision: Number(planningSnapshot.data()?.revision || 1),
            brews: projectedBrews,
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser.uid,
          });
          source = await getDoc(queueRef);
        } catch {
          // Preview may still be running production rules; use the planner
          // document we already read instead of blocking the creation UI.
        }
      }
    } catch {
      // Non-planner users use the approved-user projection when available.
    }
  }

  const queueBrews = source.exists() && Array.isArray(source.data()?.brews)
    ? (source.data().brews as BrewPlanWithMeta[])
    : [];
  const plannerBrews = plannerFallback || [];
  const brews = plannerBrews.some((brew) => !!brew.batchNumber)
    ? plannerBrews
    : queueBrews;

  return brews
    .filter((brew) => !!brew.batchNumber)
    .map((brew) => ({
      batchNumber: String(brew.batchNumber),
      style: String(brew.style || ""),
      tankId: String(brew.tankId || ""),
      date: String(brew.date || ""),
    }));
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
    const hints = [...current, ...next].filter((hint) => {
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
