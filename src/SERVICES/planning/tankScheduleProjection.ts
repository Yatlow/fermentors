import { addDays, sameStyle, type Settings, type WeekPlan } from "./planningEngine";
import { orderedTankSchedule, type TankScheduleCycle, type TankSchedulePackaging } from "./tankSchedule";

function normalizedBatch(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function readyDateFor(style: string, brewDate: string, settings: Settings): string {
  const leads = settings.products.filter((product) => sameStyle(product.style, style)).map((product) => product.leadDays);
  return addDays(brewDate, Math.max(...leads, 21));
}

function cycleId(tankId: string, brewId: string, batchNumber?: string) {
  return tankId + ":" + (batchNumber || brewId);
}

/** Read-only bridge from committed planningWeeks to canonical tank lifecycle. */
export function projectTankSchedules(plans: WeekPlan[], settings: Settings): Map<string, TankScheduleCycle[]> {
  const byTank = new Map<string, TankScheduleCycle[]>();

  for (const week of plans) {
    for (const brew of week.brews ?? []) {
      if (!brew.tankId || !brew.date || !brew.style) continue;
      const batchNumber = normalizedBatch(brew.batchNumber) || undefined;
      const cycles = byTank.get(brew.tankId) ?? [];
      cycles.push({
        cycleId: cycleId(brew.tankId, brew.id, batchNumber),
        batchNumber,
        style: brew.style,
        brewDate: brew.date,
        readyDate: readyDateFor(brew.style, brew.date, settings),
        status: "planned",
        packaging: [],
      });
      byTank.set(brew.tankId, cycles);
    }
  }

  for (const [tankId, cycles] of byTank) byTank.set(tankId, orderedTankSchedule(cycles));

  for (const week of plans) {
    for (const run of week.packaging ?? []) {
      if (!run.tankId) continue;
      const cycles = byTank.get(run.tankId);
      if (!cycles?.length) continue;
      const batch = normalizedBatch(run.batchNumber);
      const dated = String(run.date ?? "");
      const candidates = cycles.filter((cycle) => {
        if (batch && normalizedBatch(cycle.batchNumber) !== batch) return false;
        if (!dated) return true;
        return cycle.brewDate <= dated;
      });
      const target = candidates.at(-1);
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
