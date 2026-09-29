import {
  collection,
  getDocsFromServer,
  query,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { addDays, dateKey, weekStart, type WeekPlan } from "./planningEngine";

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
  const pending = getDocsFromServer(
    query(
      collection(db, "planningWeeks"),
      where("id", ">=", weekStart(today)),
      where("id", "<=", weekStart(horizon)),
    ),
  ).then((planningSnapshot) => {
    const planning = new Map<string, string>();
    const planningWeekOnly = new Map<string, string>();

    planningSnapshot.docs.forEach((snapshot) => {
      const week = snapshot.data() as WeekPlan;
      const weekId = String(week.id || snapshot.id || "");

      (week.packaging ?? []).forEach((run) => {
        const keys = [
          planningKey(run.tankNumber, run.batchNumber),
          planningKey(run.tankId, run.batchNumber),
        ].filter(Boolean);
        if (!keys.length) return;

        const date = String(run.date ?? "");
        if (date) {
          if (date < today) return;
          keys.forEach((key) => earliest(planning, key, date));
          return;
        }

        if (!weekId || weekId < weekStart(today)) return;
        keys.forEach((key) => earliest(planningWeekOnly, key, weekId));
      });
    });

    return { planning, planningWeekOnly };
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
    .filter((value): value is string => Boolean(value))
    .sort();

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
  if (exactDates.length) return null;

  const weeks = planningKeys
    .map((key) => maps.planningWeekOnly.get(key))
    .filter((value): value is string => Boolean(value))
    .sort();

  return weeks[0] ? { weekStart: weeks[0] } : null;
}
