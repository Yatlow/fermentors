import { addDays, litersPerUnit, sameStyle, weeklyDemand, type Actual, type Product, type Settings, type Tank, type TankInput, type WeekPlan } from "./planningEngine";
import { openRuns } from "./dailyPlanner";

/** Pure/read-only Planning V2 shadow model. No Firebase imports, no writes. */
export type TimelinePackaging = { id?: string; week: string; date?: string; productId: string; quantity: number; remaining: number; emptyTank: boolean };
export type TankOccupancy = {
  id: string; tankId: string; tankNumber: string; source: "actual" | "planned";
  style: string; batchNumber?: string; startsAt: string; readyAt: string;
  startingLiters: number; packaging: TimelinePackaging[]; expectedEmptyAt?: string; nextOccupancyId?: string;
};
export type TankAvailability = { tankId: string; tankNumber: string; date: string | null; reason: string; occupancyId?: string };
export type TimelineIssue = { severity: "warning" | "error"; tankId?: string; message: string };
export type TimelineSupply = { occupancyId: string; tankId: string; tankNumber: string; style: string; batchNumber?: string; readyAt: string; availableLiters: number };
export type TimelinePackagingCandidate = { occupancyId: string; tankId: string; tankNumber: string; productId: string; style: string; readyAt: string; availableLiters: number; maxUnits: number };
export type TimelineBrewCandidate = { tankId: string; tankNumber: string; availableAt: string; workLiters: number };
export type PlanningTimeline = { generatedFor: string; occupancies: TankOccupancy[]; availability: TankAvailability[]; issues: TimelineIssue[]; supply: TimelineSupply[]; packagingCandidates: TimelinePackagingCandidate[]; brewCandidates: TimelineBrewCandidate[] };

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

  const plannedBrews = plans
    .flatMap((plan) => plan.brews)
    .filter((brew) => !!brew.tankId && !!brew.date && brew.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const productFor = (productId: string) => settings.products.find((product) => product.id === productId);
  const packagingForLifecycle = (tankId: string, style: string, batchNumber: string | undefined, startsAt: string, endsAt?: string) =>
    opened
      .filter((run) => run.tankId === tankId && run.remaining > 0 && !!run.date)
      .filter((run) => run.date! >= startsAt && (!endsAt || run.date! < endsAt))
      .filter((run) => !run.batchNumber || !batchNumber || String(run.batchNumber) === String(batchNumber))
      .filter((run) => {
        const product = productFor(run.productId);
        return !product || sameStyle(product.style, style);
      })
      .sort((a, b) => a.date!.localeCompare(b.date!))
      .map((run) => ({ id: run.id, week: run.week, date: run.date, productId: run.productId, quantity: run.quantity, remaining: run.remaining, emptyTank: !!run.emptyTank }));

  for (const tank of tanks) {
    const nextBrew = plannedBrews.find((brew) => brew.tankId === tank.id && brew.date > tank.brewed);
    const packaging = packagingForLifecycle(tank.id, tank.style, tank.batch, tank.brewed, nextBrew?.date);
    const expectedEmptyAt = packaging.filter((run) => run.emptyTank && run.date).map((run) => run.date!).sort()[0];
    occupancies.push({
      id: `actual:${tank.id}:${tank.batch}`, tankId: tank.id, tankNumber: tank.number, source: "actual",
      style: tank.style, batchNumber: tank.batch, startsAt: tank.brewed, readyAt: tank.ready,
      startingLiters: tank.liters, packaging, expectedEmptyAt,
    });
  }

  for (let index = 0; index < plannedBrews.length; index++) {
    const brew = plannedBrews[index];
    const nextBrew = plannedBrews.slice(index + 1).find((candidate) => candidate.tankId === brew.tankId);
    const packaging = packagingForLifecycle(brew.tankId, brew.style, brew.batchNumber, brew.date, nextBrew?.date);
    const expectedEmptyAt = packaging.filter((run) => run.emptyTank && run.date).map((run) => run.date!).sort()[0];
    occupancies.push({
      id: `planned:${brew.id}`, tankId: brew.tankId, tankNumber: tankNumberFor(brew.tankId, sources, tanks), source: "planned",
      style: brew.style, batchNumber: brew.batchNumber, startsAt: brew.date,
      readyAt: addDays(brew.date, leadDaysFor(settings, brew.style)), startingLiters: brew.liters, packaging, expectedEmptyAt,
    });
  }

  const byTank = new Map<string, TankOccupancy[]>();
  for (const occupancy of occupancies) {
    const list = byTank.get(occupancy.tankId) ?? [];
    list.push(occupancy);
    byTank.set(occupancy.tankId, list);
  }

  const availability: TankAvailability[] = [];
  const issues: TimelineIssue[] = [];
  for (const source of sources) {
    if (Number(source.tankNumber) === 1) continue;
    const list = (byTank.get(source.id) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    list.forEach((occupancy, index) => { occupancy.nextOccupancyId = list[index + 1]?.id; });
    if (!list.length) {
      const ready = source.tankStatus === true || Number(source.action) === 0 ||
        ["stage-empty", "stage-clean", "stage-sanitized"].includes(source.stage?.className ?? "");
      availability.push({
        tankId: source.id, tankNumber: String(source.tankNumber ?? source.id),
        date: ready ? today : null, reason: ready ? "פנוי לפי מצב המיכל בפועל" : "אין occupancy מאומת ואין שחרור מתוכנן",
      });
      continue;
    }
    list.forEach((current, index) => {
      const next = list[index + 1];
      if (next && !current.expectedEmptyAt) {
        issues.push({ severity: "error", tankId: source.id, message: `מיכל ${current.tankNumber}: מתוכנן בישול נוסף ב-${next.startsAt} בלי ריקון מתוכנן של ${current.style}` });
      } else if (next && current.expectedEmptyAt && next.startsAt < current.expectedEmptyAt) {
        issues.push({ severity: "error", tankId: source.id, message: `מיכל ${current.tankNumber}: הבישול הבא ${next.startsAt} קודם לריקון ${current.expectedEmptyAt}` });
      }
    });
    const last = list.at(-1)!;
    availability.push({
      tankId: source.id, tankNumber: last.tankNumber,
      date: last.expectedEmptyAt ? addDays(last.expectedEmptyAt, 8 - new Date(`${last.expectedEmptyAt}T12:00:00Z`).getUTCDay()) : null,
      reason: last.expectedEmptyAt ? `לאחר ריקון ${last.expectedEmptyAt} וניקיון לשבוע הבא` : `האכלוס האחרון (${last.style}) טרם כולל ריקון`,
      occupancyId: last.id,
    });
  }
  const supply: TimelineSupply[] = occupancies.map((occupancy) => {
    const packedLiters = occupancy.packaging.reduce((sum, run) => {
      const product: Product | undefined = productFor(run.productId);
      return sum + (product ? run.remaining * litersPerUnit(product) : 0);
    }, 0);
    return {
      occupancyId: occupancy.id, tankId: occupancy.tankId, tankNumber: occupancy.tankNumber,
      style: occupancy.style, batchNumber: occupancy.batchNumber, readyAt: occupancy.readyAt,
      availableLiters: Math.max(0, occupancy.startingLiters - packedLiters),
    };
  });
  const packagingCandidates: TimelinePackagingCandidate[] = supply.flatMap((entry) =>
    settings.products
      .filter((product) => sameStyle(product.style, entry.style) && weeklyDemand(product) > 0)
      .map((product) => ({
        occupancyId: entry.occupancyId, tankId: entry.tankId, tankNumber: entry.tankNumber,
        productId: product.id, style: product.style, readyAt: entry.readyAt,
        availableLiters: entry.availableLiters,
        maxUnits: Math.floor(entry.availableLiters / litersPerUnit(product)),
      }))
      .filter((candidate) => candidate.maxUnits > 0),
  );
  const workLitersFor = (tankId: string) => {
    const source = sources.find((item) => item.id === tankId);
    const current = tanks.find((item) => item.id === tankId);
    const raw = Number(source?.beerVolume);
    return Number.isFinite(raw) && raw > 0 ? raw : current?.liters || 2500;
  };
  const brewCandidates: TimelineBrewCandidate[] = availability
    .filter((entry): entry is TankAvailability & { date: string } => !!entry.date)
    .map((entry) => ({
      tankId: entry.tankId, tankNumber: entry.tankNumber, availableAt: entry.date,
      workLiters: workLitersFor(entry.tankId),
    }))
    .sort((a, b) => a.availableAt.localeCompare(b.availableAt) || Number(a.tankNumber) - Number(b.tankNumber));
  return { generatedFor: today, occupancies, availability, issues, supply, packagingCandidates, brewCandidates };
}
