type GraceTank = { id: string; tankNumber?: string | number | null; action?: string | number | null; fermentationStartedAt?: unknown; cellarGraceExtensions?: Record<string, string>; cellarHealthCompletedDay?: string; cellarGraceTankIds?: string[] };
import { localDateKey } from "./healthModel";

export const FERMENTATION_GRACE_MS = 12 * 60 * 60 * 1000;
export const GRACE_COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function timestampMillis(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "object") {
    const t = value as { toDate?: () => Date; seconds?: unknown; _seconds?: unknown };
    if (typeof t.toDate === "function") {
      try { const ms = t.toDate().getTime(); if (Number.isFinite(ms)) return ms; } catch { /* try seconds */ }
    }
    const seconds = Number(t.seconds ?? t._seconds);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function fermentationGraceEnd(tank: GraceTank): number | null {
  const start = timestampMillis(tank.fermentationStartedAt);
  return start === null ? null : start + FERMENTATION_GRACE_MS;
}

export function graceExtensionEnd(completedAt: Date): number {
  // Calendar boundary in the browser's Israel-local day (not a rolling 24h).
  return new Date(completedAt.getFullYear(), completedAt.getMonth(), completedAt.getDate() + 2).getTime();
}

export function graceExtensionsAtHundred(tanks: GraceTank[], at: Date): Record<string, string> {
  const atMs = at.getTime();
  const endIso = new Date(graceExtensionEnd(at)).toISOString();
  return Object.fromEntries(tanks.filter(tank => {
    if (Number(tank.tankNumber) === 1 || Number(tank.action) !== 1) return false;
    const end = fermentationGraceEnd(tank);
    return end !== null && end >= atMs && end <= atMs + GRACE_COMPLETION_WINDOW_MS;
  }).map(tank => [String(tank.id), endIso]));
}

export function isInMeasurementGrace(tank: GraceTank, tankOne?: GraceTank, now = new Date()): boolean {
  const start = timestampMillis(tank.fermentationStartedAt);
  const normalEnd = fermentationGraceEnd(tank);
  const nowMs = now.getTime();
  if (start !== null && normalEnd !== null && nowMs >= start && nowMs < normalEnd) return true;
  const state = tankOne as (GraceTank & {
    cellarGraceExtensions?: Record<string, string>;
    cellarHealthCompletedDay?: string;
    cellarGraceTankIds?: string[];
  }) | undefined;
  const extension = timestampMillis(state?.cellarGraceExtensions?.[String(tank.id)]);
  if (extension !== null && nowMs < extension && start !== null && nowMs >= start) return true;
  // Preserve the existing same-calendar-day score snapshot for older clients.
  return state?.cellarHealthCompletedDay === localDateKey(now) &&
    (state.cellarGraceTankIds ?? []).includes(String(tank.id));
}
