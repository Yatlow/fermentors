import {
  collection,
  getDocsFromServer,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { addDays, dateKey, weekStart, type WeekPlan } from "./planningEngine";

export type PlannedTankPackaging = {
  date: string;
  source: "planning" | "calendar";
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

let cache: {
  loadedAt: number;
  data?: { planning: Map<string, string>; calendar: Map<string, string> };
  pending?: Promise<{ planning: Map<string, string>; calendar: Map<string, string> }>;
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
        where("timestamp", ">=", Timestamp.fromDate(new Date(`${today}T00:00:00`))),
        where("timestamp", "<", Timestamp.fromDate(endDate)),
      ),
    ),
  ]).then(([planningSnapshot, calendarSnapshot]) => {
    const planning = new Map<string, string>();
    planningSnapshot.docs.forEach((snapshot) => {
      const week = snapshot.data() as WeekPlan;
      (week.packaging ?? []).forEach((run) => {
        const date = String(run.date ?? "");
        if (!date || date < today) return;
        const keys = [
          normalizeTank(run.tankNumber),
          normalizeTank(run.tankId),
        ].filter(Boolean);
        keys.forEach((key) => earliest(planning, key, date));
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

    return { planning, calendar };
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

export async function getPlannedPackagingForTank(input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
}): Promise<PlannedTankPackaging | null> {
  const maps = await loadFuturePackagingMaps();
  const keys = [
    normalizeTank(input.tankNumber),
    normalizeTank(input.tankId),
  ].filter(Boolean);

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
