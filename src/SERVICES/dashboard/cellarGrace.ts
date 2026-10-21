/** The cellar grace clock is independent of the 00:00 daily measurement reset. */
export const FERMENTATION_GRACE_MS = 12 * 60 * 60 * 1000;
export const GRACE_RESET_HOUR = 4;

type GraceTank = {
  id: string;
  tankNumber?: string | number | null;
  action?: string | number | null;
  fermentationStartedAt?: unknown;
};

export type DailyRoundFields = { temp: boolean; pressure: boolean; plato: boolean; pH: boolean };
export type GraceRoundTank = GraceTank & {
  stage?: { name?: string } | null;
  currentData?: { temp?: string | number | null } | null;
};

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

/** Most recent local 04:00 boundary, using local calendar arithmetic for DST. */
export function graceDayStart(at: Date = new Date()): Date {
  const boundary = new Date(at.getFullYear(), at.getMonth(), at.getDate(), GRACE_RESET_HOUR);
  if (at.getTime() < boundary.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

export function isInInitialMeasurementGrace(tank: GraceTank, at: Date = new Date()): boolean {
  if (Number(tank.action) !== 1 || Number(tank.tankNumber) === 1) return false;
  const start = timestampMillis(tank.fermentationStartedAt);
  const end = fermentationGraceEnd(tank);
  return start !== null && end !== null && at.getTime() >= start && at.getTime() < end;
}

function completedApplicableFields(tank: GraceRoundTank, fields: DailyRoundFields | undefined): boolean {
  if (!fields?.temp || !fields.pressure) return false;
  const hot = tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
  return !hot || (fields.plato && fields.pH);
}

/**
 * Stateless grace classification:
 * - Always exempt during the first 12 hours.
 * - After 12 hours, a tank whose original grace ended in the current 04:00
 *   cycle remains optional ONLY if all veteran tanks have completed the
 *   measurements belonging to that grace day.
 * - A tank whose 12 hours ended on/before the last 04:00 is a veteran.
 *
 * fieldsByTankId must be measured on graceDayStart(at)'s LOCAL CALENDAR DATE.
 * Before 04:00 that is yesterday. A wholly complete NEW calendar day's round
 * may also grant the exemption, but never combine half-rounds across days.
 * Missing/unavailable veteran history never grants a conditional exemption.
 * No Firestore state, retroactive writes, or circular dependency is needed.
 */
export function measurementGraceTankIds(
  tanks: GraceRoundTank[],
  fieldsByTankId: Record<string, DailyRoundFields>,
  at: Date = new Date(),
  calendarTodayFieldsByTankId: Record<string, DailyRoundFields> = fieldsByTankId,
): Set<string> {
  const nowMs = at.getTime();
  const cycleStartMs = graceDayStart(at).getTime();
  const active = tanks.filter(tank => Number(tank.action) === 1 && Number(tank.tankNumber) !== 1);
  const veterans = active.filter(tank => {
    const end = fermentationGraceEnd(tank);
    return end === null || end <= cycleStartMs;
  });
  const completeRound = (fields: Record<string, DailyRoundFields>) =>
    veterans.every(tank => completedApplicableFields(tank, fields[tank.id]));
  const veteransComplete = completeRound(fieldsByTankId) || completeRound(calendarTodayFieldsByTankId);

  return new Set(active.filter(tank => {
    const start = timestampMillis(tank.fermentationStartedAt);
    const end = fermentationGraceEnd(tank);
    if (start === null || end === null || start > nowMs) return false;
    if (nowMs < end) return true; // Absolute minimum of 12 hours, even over 04:00.
    return end > cycleStartMs && veteransComplete;
  }).map(tank => String(tank.id)));
}

/** hh:mm elapsed from transfer (hours do not wrap after 24). */
export function elapsedFermentationHours(tank: GraceTank, at: Date = new Date()): string | null {
  const start = timestampMillis(tank.fermentationStartedAt);
  if (start === null || at.getTime() < start) return null;
  const minutes = Math.floor((at.getTime() - start) / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Show transfer time ONLY while this tank actually has a grace exemption. */
export function graceElapsedLabel(tank: GraceTank, exempt: boolean, at: Date = new Date()): string | null {
  if (!exempt || Number(tank.action) !== 1) return null;
  const elapsed = elapsedFermentationHours(tank, at);
  return elapsed === null ? null : `עברו ${elapsed} שעות מהעברה למיכל`;
}

/** Fully measured optional tanks add +1/+1; partial ones never add a required tank. */
export function completedDailyRoundKpi(
  results: ReadonlyArray<{ tankNumber: string; completeMeasurements: boolean }>,
  graceTankNumbers: ReadonlySet<string>,
): { checkedTanks: number; completeMeasurementTankNumbers: string[] } {
  const counted = results.filter(row =>
    !graceTankNumbers.has(row.tankNumber) || row.completeMeasurements
  );
  return {
    checkedTanks: counted.length,
    completeMeasurementTankNumbers: counted.filter(row => row.completeMeasurements).map(row => row.tankNumber),
  };
}

/** A new fermentation tank is eligible for optional Plato/pH readings before
 * its first temperature has been measured; veteran/cold tanks keep the hot filter. */
export function shouldShowPlatoPhTank(
  tank: GraceRoundTank,
  graceTankIds: ReadonlySet<string>,
): boolean {
  if (Number(tank.tankNumber) === 1) return false;
  const hot = tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
  return hot || (Number(tank.action) === 1 && tank.stage?.name === "בתסיסה" && graceTankIds.has(String(tank.id)));
}
