import { addDays, sameStyle, type Actual, type Settings, type Tank, type TankInput, type WeekPlan } from "./planningEngine";
import { openRuns } from "./dailyPlanner";

/** Pure/read-only Planning V2 shadow model. No Firebase imports, no writes. */
export type TimelinePackaging = { id?: string; week: string; date?: string; productId: string; quantity: number; remaining: number; emptyTank: boolean };
export type TankOccupancy = {
  id: string; tankId: string; tankNumber: string; source: "actual" | "planned";
  style: string; batchNumber?: string; startsAt: string; readyAt: string;
  startingLiters: number; packaging: TimelinePackaging[]; expectedEmptyAt?: string; nextOccupancyId?: string;
};
export type PlanningTimeline = { generatedFor: string; occupancies: TankOccupancy[] };

const leadDaysFor = (settings: Settings, style: string) => {
  const leads = settings.products.filter((p) => sameStyle(p.style, style)).map((p) => p.leadDays);
  return leads.length ? Math.max(...leads) : style.includes("לאגר") ? 50 : 21;
};
const tankNumberFor = (tankId: string, sources: TankInput[], tanks: Tank[]) =>
  String(tanks.find((tank) => tank.id === tankId)?.number ?? sources.find((source) => source.id === tankId)?.tankNumber ?? tankId);

export function buildPlanningTimelineV2({ today, settings, sources, tanks, plans, actuals }: {
  today: string; settings: Settings; sources: TankInput[]; tanks: Tank[]; plans: WeekPlan[]; actuals: Actual[];
}): PlanningTimeline {
  const opened = openRuns(plans, settings.products, actuals);
  const occupancies: TankOccupancy[] = [];

  for (const tank of tanks) {
    const packaging = opened
      .filter((run) => run.tankId === tank.id && run.remaining > 0)
      .filter((run) => !run.date || run.date >= tank.brewed)
      .sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99"))
      .map((run) => ({ id: run.id, week: run.week, date: run.date, productId: run.productId, quantity: run.quantity, remaining: run.remaining, emptyTank: !!run.emptyTank }));
    const expectedEmptyAt = packaging.filter((run) => run.emptyTank && run.date).map((run) => run.date!).sort()[0];
    occupancies.push({
      id: `actual:${tank.id}:${tank.batch}`, tankId: tank.id, tankNumber: tank.number, source: "actual",
      style: tank.style, batchNumber: tank.batch, startsAt: tank.brewed, readyAt: tank.ready,
      startingLiters: tank.liters, packaging, expectedEmptyAt,
    });
  }

  for (const plan of [...plans].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const brew of [...plan.brews].sort((a, b) => a.date.localeCompare(b.date))) {
      if (!brew.tankId || !brew.date || brew.date < today) continue;
      const packaging = opened
        .filter((run) => run.tankId === brew.tankId && run.remaining > 0 && !!run.date && run.date! >= brew.date)
        .sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99"))
        .map((run) => ({ id: run.id, week: run.week, date: run.date, productId: run.productId, quantity: run.quantity, remaining: run.remaining, emptyTank: !!run.emptyTank }));
      const expectedEmptyAt = packaging.filter((run) => run.emptyTank && run.date).map((run) => run.date!).sort()[0];
      occupancies.push({
        id: `planned:${brew.id}`, tankId: brew.tankId, tankNumber: tankNumberFor(brew.tankId, sources, tanks), source: "planned",
        style: brew.style, batchNumber: brew.batchNumber, startsAt: brew.date,
        readyAt: addDays(brew.date, leadDaysFor(settings, brew.style)), startingLiters: brew.liters, packaging, expectedEmptyAt,
      });
    }
  }

  const byTank = new Map<string, TankOccupancy[]>();
  for (const occupancy of occupancies) {
    const list = byTank.get(occupancy.tankId) ?? []; list.push(occupancy); byTank.set(occupancy.tankId, list);
  }
  for (const list of byTank.values()) {
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    list.forEach((occupancy, index) => { occupancy.nextOccupancyId = list[index + 1]?.id; });
  }
  return { generatedFor: today, occupancies };
}
