import { weekStart, type WeekPlan } from "./planningEngine";
import { brewById, resolvePackagingBrewId, type PackagingPlan } from "./planIdentity";
import { projectTankSchedules } from "./tankScheduleProjection";

export type PackagingMaps = {
  planning: Map<string, string>;
  planningWeekOnly: Map<string, string>;
  planningByTank: Map<string, string>;
  planningWeekOnlyByTank: Map<string, string>;
};

function earliest(map: Map<string, string>, key: string, date: string) {
  if (!key || !date) return;
  const current = map.get(key);
  if (!current || date < current) map.set(key, date);
}

const normalizeTank = (value: unknown) => String(value ?? "").trim();
const normalizeBatch = (value: unknown) => String(value ?? "").replace("#", "").trim();
const tankKey = (tank: unknown) => normalizeTank(tank);
const planningKey = (tank: unknown, batch: unknown) => {
  const normalizedTank = normalizeTank(tank);
  const normalizedBatch = normalizeBatch(batch);
  return normalizedTank && normalizedBatch ? `${normalizedTank}::${normalizedBatch}` : "";
};

export function projectPlannedPackagingMaps(plans: WeekPlan[], today: string): PackagingMaps {
  const planning = new Map<string, string>();
  const planningWeekOnly = new Map<string, string>();
  const planningByTank = new Map<string, string>();
  const planningWeekOnlyByTank = new Map<string, string>();

  const schedules = projectTankSchedules(plans);
  const projectedBrewIds = new Set<string>();
  for (const [tankId, cycles] of schedules) {
    for (const cycle of cycles) {
      projectedBrewIds.add(cycle.cycleId);
      const batch = cycle.batchNumber ?? cycle.plannedBatchNumber;
      const key = planningKey(tankId, batch);
      for (const item of cycle.packaging) {
        if (!item.date || item.date < today) continue;
        if (key) earliest(planning, key, item.date);
        if (!batch) earliest(planningByTank, tankKey(tankId), item.date);
      }
    }
  }

  for (const week of plans) {
    const weekId = String(week.id || "");
    for (const raw of week.packaging ?? []) {
      const run = raw as PackagingPlan;
      const brewId = resolvePackagingBrewId(run, plans);
      const linkedBrew = brewId ? brewById(plans, brewId) : null;
      if (linkedBrew && brewId && projectedBrewIds.has(brewId)) continue;

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
}

export function plannedPackagingDateForTank(maps: PackagingMaps, input: {
  tankId?: string | number | null;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
}): string | null {
  const keys = [planningKey(input.tankNumber, input.batchNumber), planningKey(input.tankId, input.batchNumber)].filter(Boolean);
  const dates = keys.map((key) => maps.planning.get(key)).filter((value): value is string => Boolean(value));
  dates.push(...[input.tankNumber, input.tankId].map(tankKey).filter(Boolean).map((key) => maps.planningByTank.get(key)).filter((value): value is string => Boolean(value)));
  dates.sort();
  return dates[0] ?? null;
}
