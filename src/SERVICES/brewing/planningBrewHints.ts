import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../../firebase";
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
    const snapshot = await getDoc(doc(db, "brewPlanningQueue", weekId));
    let source = snapshot;
    let plannerFallback: BrewPlanWithMeta[] | null = null;

    if (!source.exists() && auth.currentUser) {
      try {
        const planningSnapshot = await getDoc(
          doc(db, "planningWeeks", weekId),
        );
        if (planningSnapshot.exists()) {
          const rawBrews = Array.isArray(
            planningSnapshot.data()?.brews,
          )
            ? (planningSnapshot.data().brews as BrewPlanWithMeta[])
            : [];
          plannerFallback = rawBrews;
          const projectedBrews = rawBrews
            .filter((brew) => !!brew.batchNumber)
            .map((brew) => ({
              id: String(
                (brew as BrewPlanWithMeta & { id?: string }).id ||
                  "",
              ),
              batchNumber: String(brew.batchNumber),
              style: String(brew.style || ""),
              tankId: String(brew.tankId || ""),
              date: String(brew.date || ""),
            }));

          try {
            await setDoc(doc(db, "brewPlanningQueue", weekId), {
              id: weekId,
              revision: Number(
                planningSnapshot.data()?.revision || 1,
              ),
              brews: projectedBrews,
              updatedAt: serverTimestamp(),
              updatedBy: auth.currentUser.uid,
            });
            source = await getDoc(
              doc(db, "brewPlanningQueue", weekId),
            );
          } catch {
            // PR previews use the production Firestore rules, so the
            // projection write may remain blocked until the rules ship.
          }
        }
      } catch {
        // Non-planner users cannot read planningWeeks. They use the
        // approved-user projection once a planner has created it.
      }
    }

    if (!source.exists() && !plannerFallback) {
      return { weekId, hints: [], available: true };
    }

    const brews = source.exists()
      ? Array.isArray(source.data()?.brews)
        ? (source.data().brews as BrewPlanWithMeta[])
        : []
      : plannerFallback || [];

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
    return { weekId, hints: [], available: false };
  }
}
