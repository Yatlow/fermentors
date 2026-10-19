import { isInMeasurementGrace } from "./cellarGrace";
import { dailyMeasurementProgress, type HealthMeasurement } from "./healthModel";

export type CellarBadgeFields = { temp: boolean; pressure: boolean; plato: boolean; pH: boolean };

export type CellarBadgeTank = {
  id: string;
  tankNumber?: string | number | null;
  action?: string | number | null;
  batchNumber?: string | number | null;
  stage?: { name?: string } | null;
  currentData?: { temp?: string | number | null } | null;
  fermentationStartedAt?: unknown;
};

export type CellarBadgeIgnored = {
  tankNumber: string;
  batchNumber: string;
  recommendationKey: string;
};

/** Reuse the dashboard's measurement parser so every navigation view sees the same fields. */
export function cellarBadgeFieldsForDay(
  measurements: HealthMeasurement[],
  today: Date = new Date(),
): CellarBadgeFields {
  const progress = dailyMeasurementProgress(measurements, true, today);
  return {
    temp: !progress.missingFields.includes("temp"),
    pressure: !progress.missingFields.includes("pressure"),
    plato: !progress.missingFields.includes("plato"),
    pH: !progress.missingFields.includes("pH"),
  };
}

/**
 * Mirrors the HealthDashboard measurementRound alert: one pending entry per
 * physical tank; respects fermentation grace, ignored rounds, and hot/cold
 * measurement fields. A tank whose measurement history has not loaded is NOT
 * presumed incomplete (preventing a false "all tanks pending" badge).
 */
export function pendingCellarMeasurementTankNumbers(
  tanks: CellarBadgeTank[],
  fieldsByTankId: Record<string, CellarBadgeFields>,
  ignoredToday: CellarBadgeIgnored[] = [],
  now: Date = new Date(),
): string[] {
  const graceSnapshotTank = tanks.find((tank) => Number(tank.tankNumber) === 1);
  const pending = new Set<string>();

  for (const tank of tanks) {
    if (Number(tank.tankNumber) === 1 || Number(tank.action) !== 1) continue;
    if (isInMeasurementGrace(tank, graceSnapshotTank, now)) continue;

    const fields = fieldsByTankId[tank.id];
    if (!fields) continue;

    const tankNumber = String(tank.tankNumber ?? tank.id);
    const batchNumber = String(tank.batchNumber ?? "").replace("#", "").trim();
    if (batchNumber && ignoredToday.some((row) =>
      row.recommendationKey === "measurementRound" &&
      String(row.tankNumber).trim() === tankNumber &&
      String(row.batchNumber).replace("#", "").trim() === batchNumber
    )) continue;

    const isHot = tank.stage?.name === "בתסיסה" && Number(tank.currentData?.temp) > 9;
    if (!fields.temp || !fields.pressure || (isHot && (!fields.plato || !fields.pH))) {
      pending.add(tankNumber);
    }
  }

  return [...pending].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}
