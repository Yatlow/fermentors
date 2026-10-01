import { collection, getDocsFromCache, getDocsFromServer, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { recordGlobalServerRead } from "../globalReadDiagnostics";
import { addDays, dateKey, weekStart, type WeekPlan } from "./planningEngine";
import { plannedPackagingDateForTank, projectPlannedPackagingMaps, type PackagingMaps } from "./plannedPackagingProjection";

export type PlannedTankPackaging = { date: string; source: "planning" };
export type PlannedTankPackagingWeek = { weekStart: string };

// Dashboard packaging is planning metadata, not a hard real-time control path.
// Keep one projection for the whole browser session/day instead of forcing a
// server query every two minutes. Firestore's persistent cache is good enough
// for repeat visits; the server remains the cold-cache fallback.
const CACHE_MS = 30 * 60 * 1000;
let cache: { loadedAt: number; day: string; data?: PackagingMaps; pending?: Promise<PackagingMaps> } | null = null;
const tankKey = (value: unknown) => String(value ?? "").trim();
const batchKey = (value: unknown) => String(value ?? "").replace("#", "").trim();
const planningKey = (tank: unknown, batch: unknown) => {
  const t = tankKey(tank);
  const b = batchKey(batch);
  return t && b ? `${t}::${b}` : "";
};

async function loadFuturePackagingMaps() {
  const now = Date.now();
  const today = dateKey(new Date());
  if (cache?.day === today && cache?.data && now - cache.loadedAt < CACHE_MS) return cache.data;
  if (cache?.day === today && cache?.pending) return cache.pending;

  const horizon = addDays(today, 84);
  const historyStart = weekStart(addDays(today, -84));
  const planningQuery = query(
    collection(db, "planningWeeks"),
    where("id", ">=", historyStart),
    where("id", "<=", weekStart(horizon)),
  );

  const project = (snapshot: Awaited<ReturnType<typeof getDocsFromServer>>) => {
    const plans = snapshot.docs
      .map((doc) => doc.data() as WeekPlan)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return projectPlannedPackagingMaps(plans, today);
  };

  const pending = (async () => {
    try {
      const local = await getDocsFromCache(planningQuery);
      if (!local.empty) return project(local);
    } catch {
      // IndexedDB can be unavailable/empty on a cold browser. Fall through to
      // one authoritative server query and let Firestore persist that result.
    }

    const snapshot = await getDocsFromServer(planningQuery);
    recordGlobalServerRead("Dashboard planning weeks", snapshot.size);
    return project(snapshot);
  })();

  cache = { loadedAt: now, day: today, pending };
  try {
    const data = await pending;
    cache = { loadedAt: Date.now(), day: today, data };
    return data;
  } catch (error) {
    cache = null;
    throw error;
  }
}

export async function getPlannedPackagingForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
}): Promise<PlannedTankPackaging | null> {
  const maps = await loadFuturePackagingMaps();
  const date = plannedPackagingDateForTank(maps, input);
  return date ? { date, source: "planning" } : null;
}

export async function getUndatedPlannedPackagingWeekForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
}): Promise<PlannedTankPackagingWeek | null> {
  const maps = await loadFuturePackagingMaps();
  if (plannedPackagingDateForTank(maps, input)) return null;
  const keys = [planningKey(input.tankNumber, input.batchNumber), planningKey(input.tankId, input.batchNumber)].filter(Boolean);
  const weeks = keys.map((key) => maps.planningWeekOnly.get(key)).filter((value): value is string => Boolean(value));
  weeks.push(...[input.tankNumber, input.tankId].map(tankKey).filter(Boolean).map((key) => maps.planningWeekOnlyByTank.get(key)).filter((value): value is string => Boolean(value)));
  weeks.sort();
  return weeks[0] ? { weekStart: weeks[0] } : null;
}
