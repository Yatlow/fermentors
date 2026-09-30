import {
  collection,
  getDocsFromServer,
  query,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { recordGlobalServerRead } from "../globalReadDiagnostics";
import { addDays, dateKey, weekStart, type WeekPlan } from "./planningEngine";
import { brewById, resolvePackagingBrewId, type PackagingPlan } from "./planIdentity";
import { projectTankSchedules } from "./tankScheduleProjection";

export type PlannedTankPackaging = {
  date: string;
  source: "planning";
};

export type PlannedTankPackagingWeek = {
  weekStart: string;
};

const CACHE_MS = 2 * 60 * 1000;

type PackagingMaps = {
  planning: Map<string, string>;
  planningWeekOnly: Map<string, string>;
  planningByTank: Map<string, string>;
  planningWeekOnlyByTank: Map<string, string>;
};

let cache: {
  loadedAt: number;
  data?: PackagingMaps;
  pending?: Promise<PackagingMaps>;
} | null = null;

function earliest(map: Map<string, string>, key: string, date: string) {
  if (!key || !date) return;
  const current = map.get(key);
  if (!current || date < current) map.set(key, date);
}

function normalizeTank(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeBatch(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function tankKey(tank: unknown): string {
  return normalizeTank(tank);
}

function planningKey(tank: unknown, batch: unknown): string {
  const normalizedTank = normalizeTank(tank);
  const normalizedBatch = normalizeBatch(batch);
  return normalizedTank && normalizedBatch ? `${normalizedTank}::${normalizedBatch}` : "";
}

async function loadFuturePackagingMaps() {
  const now = Date.now();
  if (cache?.data && now - cache.loadedAt < CACHE_MS) return cache.data;
  if (cache?.pending) return cache.pending;

  const today = dateKey(new Date());
  const horizon = addDays(today, 84);
  const historyStart = weekStart(addDays(today, -84));
  const pending = getDocsFromServer(
    query(
      collection(db, "planningWeeks"),
      where("id", ">=", historyStart),
      where("id", "<=", weekStart(horizon)),
    ),
  ).then((planningSnapshot) => {
    recordGlobalServerRead("Dashboard planning weeks", planningSnapshot.size);
    const planning = new Map<string, string>();
    const planningWeekOnly = new Map<string, string>();
    const planningByTank = new Map<string, string>();
    const planningWeekOnlyByTank = new Map<string, string>();
    const plans = planningSnapshot.docs
      .map((snapshot) => snapshot.data() as WeekPlan)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const schedules = projectTankSchedules(plans);
    const projectedBrewIds = new Set<string>();
    for (const [tankId, cycles] of schedules) {
      for (const cycle of cycles) {
        projectedBrewIds.add(cycle.brewId);
        const batch = cycle.batchNumber ?? cycle.plannedBatchNumber;
        const key = planningKey(tankId, batch);
        for (const item of cycle.packaging) {
          if (!item.date || item.date < today) continue;
          if (key) earliest(planning, key, item.date);
          if (!batch) earliest(planningByTank, tankKey(tankId), item.date);
        }
      }
    }

    // Current physical cycles may pre-date the planning window. A packaging row
    // can still resolve to a brewId through recommendation identity even when no
    // projected lifecycle for that brew exists in this query window. Only skip
    // the snapshot bridge when the resolved brew is actually represented by the
    // canonical projection above; otherwise tank/batch is the only safe bridge
    // back to the live fermentor card.
    for (const week of plans) {
      const weekId = String(week.id || "");
      for (const raw of week.packaging ?? []) {
        const run = raw as PackagingPlan;
        const brewId = resolvePackagingBrewId(run, plans);
        const linkedBrew = brewId ? brewById(plans, brewId) : null;
        if (linkedBrew && projectedBrewIds.has(brewId!)) continue;

        const canonicalTankId = run.tankId || linkedBrew?.tankId;
        const canonicalTankNumber = run.tankNumber;
        const canonicalBatch = run.batchNumber || linkedBrew?.batchNumber;
        const keys = [
          planningKey(canonicalTankNumber, canonicalBatch),
          planningKey(canonicalTankId, canonicalBatch),
        ].filter(Boolean);
        const legacyTankKeys = canonicalBatch
          ? []
          : [tankKey(canonicalTankNumber), tankKey(canonicalTankId)].filter(Boolean);
        if (!keys.length && !legacyTankKeys.length) continue;

        const date = String(run.date ?? "");
        if (date) {
          if (date < today) continue;
          keys.forEach((key) => earliest(planning, key, date));
          legacyTankKeys.forEach((key) => earliest(planningByTank, key, date));
          continue;
        }

        if (!weekId || weekId < weekStart(today)) continue;
        keys.forEach((key) => earliest(planningWeekOnly, key, weekId));
        legacyTankKeys.forEach((key) => earliest(planningWeekOnlyByTank, key, weekId));
      }
    }

    return { planning, planningWeekOnly, planningByTank, planningWeekOnlyByTank };
  });

  cache = { loadedAt: now, pending };
  try {
    const data = await pending;
    cache = { loadedAt: Date.now(), data };
    return data;
  } catch (error) {
    cache = null;
    throw error;
  }
}

function planningLookupKeys(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
}) {
  return [
    planningKey(input.tankNumber, input.batchNumber),
    planningKey(input.tankId, input.batchNumber),
  ].filter(Boolean);
}

export async function getPlannedPackagingForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
}): Promise<PlannedTankPackaging | null> {
  const maps = await loadFuturePackagingMaps();
  const planningKeys = planningLookupKeys(input);

  const planningDates = planningKeys
    .map((key) => maps.planning.get(key))
    .filter((value): value is string => Boolean(value));
  planningDates.push(...[input.tankNumber, input.tankId].map(tankKey).filter(Boolean).map((key) => maps.planningByTank.get(key)).filter((value): value is string => Boolean(value)));
  planningDates.sort();

  return planningDates[0]
    ? { date: planningDates[0], source: "planning" }
    : null;
}

export async function getUndatedPlannedPackagingWeekForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
}): Promise<PlannedTankPackagingWeek | null> {
  const maps = await loadFuturePackagingMaps();
  const planningKeys = planningLookupKeys(input);

  const exactDates = planningKeys
    .map((key) => maps.planning.get(key))
    .filter((value): value is string => Boolean(value));
  const legacyExactDates = [input.tankNumber, input.tankId].map(tankKey).filter(Boolean).map((key) => maps.planningByTank.get(key)).filter((value): value is string => Boolean(value));
  if (exactDates.length || legacyExactDates.length) return null;

  const weeks = planningKeys
    .map((key) => maps.planningWeekOnly.get(key))
    .filter((value): value is string => Boolean(value));
  weeks.push(...[input.tankNumber, input.tankId].map(tankKey).filter(Boolean).map((key) => maps.planningWeekOnlyByTank.get(key)).filter((value): value is string => Boolean(value)));
  weeks.sort();

  return weeks[0] ? { weekStart: weeks[0] } : null;
}
