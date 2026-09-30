import {
  addDays,
  litersPerUnit,
  sameStyle,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import { brewById, resolvePackagingBrewId, type PackagingPlan } from "./planIdentity";
import { projectTankSchedules } from "./tankScheduleProjection";
import { tankAvailableForBrewAt } from "./tankSchedule";

type DisplayBrew = WeekPlan["brews"][number] & { tentativeTankId?: string };

/**
 * Display-only enrichment for five-week planning.
 * Canonical brewId/cycleId owns every relationship. tankId/tankNumber/batchNumber
 * remain snapshots for display and legacy rows only.
 */
export function withTentativeFiveWeekTanks(
  plans: WeekPlan[],
  tanks: Tank[],
  settings: Settings,
): WeekPlan[] {
  const schedules = projectTankSchedules(plans, settings);
  const reservedLegacyLiters = new Map<string, number>();

  // Only unresolved legacy packaging is allowed to reserve by tank snapshot.
  // Canonically linked packaging is already attached to its cycle by projection.
  for (const plan of plans) {
    for (const raw of plan.packaging) {
      const run = raw as PackagingPlan;
      if (resolvePackagingBrewId(run, plans) || !run.tankId || run.quantity <= 0) continue;
      const product = settings.products.find((item) => item.id === run.productId);
      if (!product) continue;
      reservedLegacyLiters.set(
        run.tankId,
        (reservedLegacyLiters.get(run.tankId) ?? 0) + run.quantity * litersPerUnit(product),
      );
    }
  }

  return [...plans]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((plan) => {
      const tentativeThisWeek = new Set<string>();
      const weekEnd = addDays(plan.id, 6);

      const brews = plan.brews.map((rawBrew) => {
        const brew = rawBrew as DisplayBrew;
        if (brew.tankId) return { ...brew, tentativeTankId: undefined } as DisplayBrew;

        const targetDate = brew.date || plan.id;
        const candidate = tanks
          .filter((tank) => {
            if (tank.ready > weekEnd || tentativeThisWeek.has(tank.id)) return false;
            return tankAvailableForBrewAt(schedules.get(tank.id) ?? [], targetDate);
          })
          .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];

        if (!candidate) return { ...brew, tentativeTankId: undefined } as DisplayBrew;
        tentativeThisWeek.add(candidate.id);
        return { ...brew, tentativeTankId: candidate.id } as DisplayBrew;
      });

      const packaging = plan.packaging.map((raw) => {
        const run = raw as PackagingPlan;
        const brewId = resolvePackagingBrewId(run, plans);
        const linkedBrew = brewId ? brewById(plans, brewId) : null;

        // Once identity resolves, never infer another tank from style/capacity.
        // The brew assignment is the source of truth even if the row carries an
        // old tank snapshot after a planner moved the brew.
        if (linkedBrew) {
          if (!linkedBrew.tankId) return { ...run, tankId: "", tankNumber: undefined };
          const tank = tanks.find((item) => item.id === linkedBrew.tankId);
          return {
            ...run,
            tankId: linkedBrew.tankId,
            tankNumber: tank ? String(tank.number) : run.tankNumber,
            batchNumber: linkedBrew.batchNumber ?? run.batchNumber,
          };
        }

        // Legacy bridge only: rows with no resolvable brewId may still use the old
        // style/capacity inference until they are migrated by a normal edit/save.
        const confirmedTank = tanks.find((tank) => tank.id === run.tankId);
        if (confirmedTank || run.tankNumber || run.quantity <= 0) return run;

        const product = settings.products.find((item) => item.id === run.productId);
        if (!product) return run;

        const neededLiters = run.quantity * litersPerUnit(product);
        const readyBy = run.date ?? weekEnd;
        const candidate = tanks
          .filter((tank) =>
            sameStyle(tank.style, product.style) &&
            tank.ready <= readyBy &&
            tank.liters - (reservedLegacyLiters.get(tank.id) ?? 0) >= neededLiters,
          )
          .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];

        if (!candidate) return run.tankId && !confirmedTank ? { ...run, tankId: "" } : run;
        reservedLegacyLiters.set(candidate.id, (reservedLegacyLiters.get(candidate.id) ?? 0) + neededLiters);
        return { ...run, tankId: "", tankNumber: `${candidate.number} (מוצע)` };
      });

      return { ...plan, brews, packaging };
    });
}
