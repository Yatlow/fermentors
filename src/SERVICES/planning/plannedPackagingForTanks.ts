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
  source: "planning" | "calendar";
};

export type PlannedTankPackagingWeek = {
  weekStart: string;
};

type CalendarPackagingEvent = {
  date?: string;
  timestamp?: number;
  actionType?: string;
  tankNumber?: string | number | null;
  containerNumber?: string | number | null;
};

const PACKAGING_ACTIONS = new Set(["הורדה", "סיום", "ביקבוק"]);
const CACHE_MS = 2 * 60 * 1000;

type PackagingMaps = {
  planning: Map<string, string>;
  planningWeekOnly: Map<string, string>;
  calendar: Map<string, string>;
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

function calendarDate(data: CalendarPackagingEvent): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(data.date ?? ""))) {
    return String(data.date);
  }
  const timestamp = Number(data.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return dateKey(new Date(timestamp));
}

async function loadFuturePackagingMaps() {
  const now = Date.now();
  if (cache?.data && now - cache.loadedAt < CACHE_MS) return cache.data;
  if (cache?.pending) return cache.pending;

  const today = dateKey(new Date());
  const horizon = addDays(today, 84);
  const endDate = new Date(`${addDays(horizon, 1)}T00:00:00`);

  const pending = Promise.all([
    getDocsFromServer(
      query(
        collection(db, "planningWeeks"),
        where("id", ">=", weekStart(today)),
        where("id", "<=", weekStart(horizon)),
      ),
    ),
    getDocsFromServer(
      query(
        collection(db, "calendar_events"),
        where("timestamp", ">=", new Date(`${today}T00:00:00`).getTime()),
        where("timestamp", "<", endDate.getTime()),
      ),
    ),
  ]).then(([planningSnapshot, calendarSnapshot]) => {
    const planning = new Map<string, string>();
    const planningWeekOnly = new Map<string, string>();

    planningSnapshot.docs.forEach((snapshot) => {
      const week = snapshot.data() as WeekPlan;
      const weekId = String(week.id || snapshot.id || "");

      (week.packaging ?? []).forEach((run) => {
        const keys = [
          normalizeTank(run.tankNumber),
          normalizeTank(run.tankId),
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

    const calendar = new Map<string, string>();
    calendarSnapshot.docs.forEach((snapshot) => {
      const event = snapshot.data() as CalendarPackagingEvent;
      if (!PACKAGING_ACTIONS.has(String(event.actionType ?? ""))) return;
      const date = calendarDate(event);
      if (!date || date < today) return;
      const tank = normalizeTank(event.tankNumber ?? event.containerNumber);
      earliest(calendar, tank, date);
    });

    return { planning, planningWeekOnly, calendar };
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

function lookupKeys(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
}) {
  return [
    normalizeTank(input.tankNumber),
    normalizeTank(input.tankId),
  ].filter(Boolean);
}

export async function getPlannedPackagingForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
}): Promise<PlannedTankPackaging | null> {
  const maps = await loadFuturePackagingMaps();
  const keys = lookupKeys(input);

  const planningDates = keys
    .map((key) => maps.planning.get(key))
    .filter((value): value is string => Boolean(value))
    .sort();
  if (planningDates[0]) return { date: planningDates[0], source: "planning" };

  const calendarDates = keys
    .map((key) => maps.calendar.get(key))
    .filter((value): value is string => Boolean(value))
    .sort();
  return calendarDates[0]
    ? { date: calendarDates[0], source: "calendar" }
    : null;
}

export async function getUndatedPlannedPackagingWeekForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
}): Promise<PlannedTankPackagingWeek | null> {
  const maps = await loadFuturePackagingMaps();
  const keys = lookupKeys(input);

  // If an exact future date already exists, the regular TankCard badge is the
  // authoritative display and no week-only fallback is needed.
  const exactDates = [
    ...keys.map((key) => maps.planning.get(key)),
    ...keys.map((key) => maps.calendar.get(key)),
  ].filter((value): value is string => Boolean(value));
  if (exactDates.length) return null;

  const weeks = keys
    .map((key) => maps.planningWeekOnly.get(key))
    .filter((value): value is string => Boolean(value))
    .sort();

  return weeks[0] ? { weekStart: weeks[0] } : null;
}
