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

/** A tank can earn measurement credit in grace, but must never add a
 * required tank to the full-round KPI or the navigation badge. */
export type DailyRoundFields = { temp: boolean; pressure: boolean; plato: boolean; pH: boolean };
export type GraceRoundTank = GraceTank & {
  stage?: { name?: string } | null;
  currentData?: { temp?: string | number | null } | null;
};

/** Return only new, non-compounding exemptions for tanks still in their ORIGINAL
 * 12-hour grace. The extension ends at midnight AFTER the next calendar day. */
export function pendingGraceExtensions(
  tanks: GraceTank[],
  tankOne: GraceTank | undefined,
  at: Date = new Date(),
): Record<string, string> {
  const candidates = graceExtensionsAtHundred(tanks, at);
  return Object.fromEntries(Object.entries(candidates).filter(([id, end]) => {
    const tank = tanks.find(item => String(item.id) === id);
    if (!tank || !isInMeasurementGrace(tank, tankOne, at)) return false;
    const normalEnd = fermentationGraceEnd(tank);
    if (normalEnd === null || normalEnd <= at.getTime()) return false;
    const existingEnd = timestampMillis(tankOne?.cellarGraceExtensions?.[id]);
    const start = timestampMillis(tank.fermentationStartedAt);
    // Never compound the grace for the same fermentation on the next day.
    // An extension that expired before the current fermentation started
    // belongs to a previous batch and must not block the new batch.
    return existingEnd === null || (start !== null && existingEnd <= start);
  }));
}

/** Unlike the cellar *health score*, the full daily measurement round is
 * complete only when every REQUIRED (non-grace) tank has today's readings.
 * Unknown/unloaded history must never trigger an extension. Can run in any view. */
export function completedRoundGraceExtensions(
  tanks: GraceRoundTank[],
  fieldsByTankId: Record<string, DailyRoundFields>,
  tankOne: GraceTank | undefined,
  at: Date = new Date(),
): Record<string, string> {
  const required = tanks.filter(tank =>
    Number(tank.tankNumber) !== 1 &&
    Number(tank.action) === 1 &&
    !isInMeasurementGrace(tank, tankOne, at)
  );
  if (required.length === 0 || required.some(tank => {
    const fields = fieldsByTankId[tank.id];
    if (!fields || !fields.temp || !fields.pressure) return true;
    const hot = tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
    return hot && (!fields.plato || !fields.pH);
  })) return {};

  return pendingGraceExtensions(tanks, tankOne, at);
}

/** hh:mm elapsed since entry to the fermenter (hours are not modulo 24). */
export function elapsedFermentationHours(tank: GraceTank, now: Date = new Date()): string | null {
  const start = timestampMillis(tank.fermentationStartedAt);
  if (start === null || now.getTime() < start) return null;
  const minutes = Math.floor((now.getTime() - start) / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A transfer timer must be shown ONLY for active tanks that are in grace. */
export function graceElapsedLabel(
  tank: GraceTank,
  tankOne: GraceTank | undefined,
  now: Date = new Date(),
): string | null {
  if (Number(tank.action) !== 1 || !isInMeasurementGrace(tank, tankOne, now)) return null;
  const elapsed = elapsedFermentationHours(tank, now);
  return elapsed === null ? null : `עברו ${elapsed} שעות מהעברה למיכל`;
}

/** Only completed voluntary grace rounds participate in the full-round KPI.
 * An incomplete grace round cannot add to the denominator; required tanks
 * participate whether complete or not. */
export function completedDailyRoundKpi(
  results: ReadonlyArray<{ tankNumber: string; completeMeasurements: boolean }>,
  graceTankNumbers: ReadonlySet<string>,
): { checkedTanks: number; completeMeasurementTankNumbers: string[] } {
  const counted = results.filter(row =>
    !graceTankNumbers.has(row.tankNumber) || row.completeMeasurements
  );
  return {
    checkedTanks: counted.length,
    completeMeasurementTankNumbers: counted
      .filter(row => row.completeMeasurements)
      .map(row => row.tankNumber),
  };
}
