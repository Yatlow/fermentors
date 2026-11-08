import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { recordGlobalServerRead } from "../globalReadDiagnostics";
import { addDays, weekStart, type WeekPlan } from "./planningEngine";
import { projectPlannedPackagingMaps, type PackagingMaps } from "./plannedPackagingProjection";

/**
 * Dashboard packaging is shared operational planning information.
 *
 * The previous 30-minute in-memory cache + getDocsFromCache shortcut kept
 * showing old shift dates on other devices, sometimes even after a reload:
 * an existing Firestore cache was never revalidated against the server.
 *
 * Subscribe ONCE for the whole dashboard rather than fetching a planning
 * query separately for each tank. A cached initial snapshot is not trusted
 * for today's physical packaging instructions; publish only server-confirmed
 * results, and keep listening for replanning on other devices.
 */
export function subscribePlannedPackagingMaps(
  today: string,
  onUpdate: (maps: PackagingMaps) => void,
  onError?: (error: Error) => void,
): () => void {
  const horizon = addDays(today, 84);
  const planningQuery = query(
    collection(db, "planningWeeks"),
    where("id", ">=", weekStart(addDays(today, -84))),
    where("id", "<=", weekStart(horizon)),
  );
  let firstServerSnapshot = true;
  return onSnapshot(
    planningQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      // Cached dates can be stale after another planner moves a shift.
      // Waiting for server confirmation is safer than displaying yesterday's
      // instructions as if they were the current production plan.
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      const plans = snapshot.docs.map((doc) => doc.data() as WeekPlan)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const reads = firstServerSnapshot ? snapshot.size : snapshot.docChanges().length;
      if (reads) recordGlobalServerRead("Dashboard planning weeks", reads);
      firstServerSnapshot = false;
      onUpdate(projectPlannedPackagingMaps(plans, today));
    },
    (error) => onError?.(error),
  );
}
