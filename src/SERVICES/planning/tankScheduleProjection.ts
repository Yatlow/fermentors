import { addDays, sameStyle, type Settings, type WeekPlan } from "./planningEngine";
import { brewById, resolvePackagingBrewId, type PackagingPlan } from "./planIdentity";
import { orderedTankSchedule, type TankScheduleCycle, type TankSchedulePackaging } from "./tankSchedule";

function normalizedBatch(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function readyDateFor(style: string, brewDate: string, settings?: Settings): string | undefined {
  if (!settings) return undefined;
  const leads = settings.products.filter((product) => sameStyle(product.style, style)).map((product) => product.leadDays);
  return addDays(brewDate, Math.max(...leads, 21));
}

/** Read-only bridge from committed planningWeeks to canonical tank lifecycle. */
export function projectTankSchedules(plans: WeekPlan[], settings?: Settings): Map<string, TankScheduleCycle[]> {
  const byTank = new Map<string, TankScheduleCycle[]>();

  for (const week of plans) {
    for (const brew of week.brews ?? []) {
      if (!brew.tankId || !brew.date || !brew.style) continue;
      const batchNumber = normalizedBatch(brew.batchNumber) || undefined;
      const cycles = byTank.get(brew.tankId) ?? [];
      const readyDate = readyDateFor(brew.style, brew.date, settings);
      cycles.push({
        cycleId: brew.id,
        plannedBatchNumber: batchNumber,
        style: brew.style,
        brewDate: brew.date,
        ...(readyDate ? { readyDate } : {}),
        status: "planned",
        packaging: [],
      });
      byTank.set(brew.tankId, cycles);
    }
  }

  for (const [tankId, cycles] of byTank) byTank.set(tankId, orderedTankSchedule(cycles));

  for (const week of plans) {
    for (const raw of week.packaging ?? []) {
      const run = raw as PackagingPlan;
      // Stable brew identity is authoritative. tankId/batchNumber are legacy
      // snapshots only, so moving or renumbering a future brew cannot orphan its
      // packaging. Legacy rows are resolved through their old snapshots.
      const brewId = resolvePackagingBrewId(run, plans);
      const linkedBrew = brewId ? brewById(plans, brewId) : null;
      const tankId = linkedBrew?.tankId ?? run.tankId;
      if (!tankId) continue;
      const cycles = byTank.get(tankId);
      if (!cycles?.length) continue;

      let target = brewId ? cycles.find((cycle) => cycle.cycleId === brewId) : undefined;
      if (!target) {
        // Legacy projection is only safe with an exact batch snapshot. Never
        // attach a tank-only packaging row to whichever cycle happens to be
        // latest on that physical tank.
        const batch = normalizedBatch(run.batchNumber);
        if (!batch) continue;
        const dated = String(run.date ?? "");
        const candidates = cycles.filter((cycle) => {
          if (normalizedBatch(cycle.batchNumber ?? cycle.plannedBatchNumber) !== batch) return false;
          if (!dated) return true;
          return cycle.brewDate <= dated;
        });
        target = candidates.at(-1);
      }
      if (!target) continue;

      const packaging: TankSchedulePackaging = {
        planId: String(run.id ?? (week.id + ":" + run.productId + ":" + (run.date ?? "undated"))),
        productId: run.productId,
        quantity: run.quantity,
        ...(run.date ? { date: run.date } : {}),
        ...(run.emptyTank === true ? { emptiesTank: true } : {}),
      };
      target.packaging.push(packaging);
      if (run.emptyTank && run.date && (!target.emptyDate || run.date < target.emptyDate)) target.emptyDate = run.date;
    }
  }

  return byTank;
}

export function serializeTankSchedules(
  schedules: Map<string, TankScheduleCycle[]>,
): Record<string, TankScheduleCycle[]> {
  return Object.fromEntries(
    [...schedules.entries()].map(([tankId, cycles]) => [tankId, orderedTankSchedule(cycles)]),
  );
}

export function changedTankSchedules(
  previous: Map<string, TankScheduleCycle[]>,
  next: Map<string, TankScheduleCycle[]>,
): Array<{ tankId: string; cycles: TankScheduleCycle[] }> {
  const tankIds = new Set([...previous.keys(), ...next.keys()]);
  return [...tankIds]
    .sort()
    .filter((tankId) => JSON.stringify(previous.get(tankId) ?? []) !== JSON.stringify(next.get(tankId) ?? []))
    .map((tankId) => ({ tankId, cycles: next.get(tankId) ?? [] }));
}
