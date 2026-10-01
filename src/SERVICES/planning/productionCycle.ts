import {
  addDays,
  litersPerUnit,
  num,
  parseDate,
  sameStyle,
  weekStart,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import { actualDate, openRuns } from "./dailyPlanner";
import type { Actual } from "./planningEngine";
import { brewById, resolvePackagingBrewId, type PackagingPlan } from "./planIdentity";
import { projectTankSchedules } from "./tankScheduleProjection";
import { orderedTankSchedule, tankCanHostCycle } from "./tankSchedule";

export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const nextBrewingWeek = (emptied: string) => addDays(weekStart(emptied), 8);

export const packagingLimit = (date: string, type: "crates" | "kegs") =>
  weekday(date) === 0 ? (type === "crates" ? 168 : 100) : type === "crates" ? 252 : Infinity;

export type TankSource = {
  id: string;
  tankNumber?: string | number | null;
  batchNumber?: string | number | null;
  brewDate?: string | null;
  beerStyle?: string | null;
  beerVolume?: unknown;
  tankStatus?: unknown;
  action?: unknown;
  stage?: { className?: string; name?: string };
};
export type Release = {
  tankId: string;
  date: string | null;
  emptyDate: string | null;
  remaining: number;
  workLiters: number;
  reason: string;
};
export type BrewSizeLabel = "בודד" | "כפול" | "משולש";

export function estimatedBrewVolume(tankNumber: unknown, beerStyle?: string | null): number {
  const tank = Number(tankNumber);
  const style = String(beerStyle ?? "");
  if (!Number.isFinite(tank) || tank <= 0) return 0;
  if (tank <= 4) return 1100;
  const isPale = style.includes("פייל");
  const isHoppyLager = style.includes("הופי") && style.includes("לאגר");
  const isLager = style.includes("לאגר");
  const isWheat = style.includes("חיטה");
  const isIpa = /ipa/i.test(style);
  if (tank <= 8) {
    if (isIpa) return 1960;
    if (isPale) return 2200;
    if (isHoppyLager || isLager) return 2500;
    if (isWheat) return 2100;
    return 2200;
  }
  if (isIpa) return 3000;
  if (isPale) return 3200;
  if (isHoppyLager) return 3600;
  if (isLager) return 3700;
  if (isWheat) return 3400;
  return 3400;
}

export function brewSizeLabel(liters: number, tankNumber?: unknown): BrewSizeLabel {
  const tank = Number(tankNumber);
  if (Number.isFinite(tank)) {
    if (tank >= 2 && tank <= 4) return "בודד";
    if (tank >= 5 && tank <= 8) return "כפול";
    if (tank >= 9) return "משולש";
  }
  if (liters <= 1500) return "בודד";
  if (liters <= 2800) return "כפול";
  return "משולש";
}

export function brewLitersForSize(style: string, size: BrewSizeLabel): number {
  const representativeTank = size === "בודד" ? 2 : size === "כפול" ? 5 : 9;
  return estimatedBrewVolume(representativeTank, style);
}

function isReadyForBrew(source: TankSource) {
  return Number(source.action) === 0 ||
    source.stage?.name === "מחכה לבישול" ||
    source.stage?.className === "stage-waiting" ||
    source.tankStatus === true ||
    ["stage-empty", "stage-clean", "stage-sanitized"].includes(source.stage?.className ?? "");
}

function normalizedBatch(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function canonicalRunTank(run: PackagingPlan, plans: WeekPlan[]): string | undefined {
  const brewId = resolvePackagingBrewId(run, plans);
  return (brewId ? brewById(plans, brewId)?.tankId : undefined) ?? run.tankId;
}

export function tankReleases(
  sources: TankSource[],
  tanks: Tank[],
  plans: WeekPlan[],
  settings: Settings,
  actuals: Actual[],
  today: string,
): Release[] {
  const schedules = projectTankSchedules(plans, settings);
  const legacyInventoryRuns = openRuns(plans, settings.products, actuals)
    .filter((r) => r.date && r.date >= today && r.remaining > 0)
    .filter((r) => !resolvePackagingBrewId(r as PackagingPlan, plans));
  const legacySpecialRuns = plans.flatMap((week) => (week.packaging ?? [])
    .filter((run) => !!run.nonInventoryStyle && !!run.nonInventoryType && !!run.date && run.date >= today && run.quantity > 0)
    .map((run, index) => ({ ...run, remaining: run.quantity, week: week.id, key: run.id ?? `${week.id}:special:${index}` })))
    .filter((run) => !resolvePackagingBrewId(run as PackagingPlan, plans));
  const legacyRuns = [...legacyInventoryRuns, ...legacySpecialRuns];

  return sources.map((source) => {
    // Release capacity describes what the physical tank can host on its NEXT
    // cycle. The beerVolume belongs to the current physical cycle and may have
    // already shrunk through fermentation/packaging, so it must never become
    // the capacity of a future planning slot.
    const estimatedNextCycleLiters = estimatedBrewVolume(source.tankNumber, source.beerStyle);
    // Legacy/free tank records may not carry tankNumber yet. In that narrow
    // case beerVolume is the only declared capacity signal and is safe because
    // there is no identifiable current physical cycle to leak forward.
    const workLiters = estimatedNextCycleLiters || (!source.tankNumber ? num(source.beerVolume) : 0);
    if (isReadyForBrew(source)) {
      const packedThisWeek = actuals
        .filter((a) => source.tankNumber != null && String(a.tankNumber) === String(source.tankNumber))
        .map(actualDate)
        .filter((date): date is string => !!date && date >= weekStart(today) && date <= today)
        .sort()
        .at(-1);
      return {
        tankId: source.id,
        date: packedThisWeek ? nextBrewingWeek(packedThisWeek) : today,
        emptyDate: packedThisWeek ?? null,
        remaining: 0,
        workLiters,
        reason: packedThisWeek
          ? "המיכל נארז השבוע; זמין לבישול מהשבוע הבא לאחר ניקיון"
          : Number(source.action) === 0 || source.stage?.name === "מחכה לבישול"
            ? "המיכל מחכה לבישול וזמין לשיבוץ · נפח המחזור הבא מחושב לפי גודל המיכל"
            : "המיכל פנוי; יש לאמת ניקיון וחיטוי",
      };
    }

    const tank = tanks.find((t) => t.id === source.id);
    if (!tank) return {
      tankId: source.id,
      date: null,
      emptyDate: null,
      remaining: 0,
      workLiters,
      reason: "חסרים נתוני מיכל מאומתים",
    };

    const cycles = orderedTankSchedule(schedules.get(source.id) ?? []);
    const sourceBatch = normalizedBatch(source.batchNumber);
    const sourceBrewDate = parseDate(source.brewDate) ?? String(source.brewDate ?? "");
    const canonicalCurrent = [...cycles].reverse().find((cycle) =>
      (sourceBatch && normalizedBatch(cycle.batchNumber ?? cycle.plannedBatchNumber) === sourceBatch) ||
      (!!sourceBrewDate && cycle.brewDate === sourceBrewDate),
    );
    if (canonicalCurrent) {
      // Current physical cycles can predate canonical brew identity. In that
      // transition case their packaging rows are intentionally legacy rows.
      // Only let an exact tank + current batch match close this cycle; tank-only
      // matching would risk attaching a future cycle's packaging here.
      let legacyCurrentEmptyDate: string | null = null;
      if (!canonicalCurrent.emptyDate && sourceBatch) {
        let legacyRemaining = tank.liters;
        for (const r of legacyRuns
          .filter((run) =>
            canonicalRunTank(run as PackagingPlan, plans) === source.id &&
            normalizedBatch((run as PackagingPlan).batchNumber) === sourceBatch)
          .sort((a, b) => a.date!.localeCompare(b.date!))) {
          const p = settings.products.find((product) => product.id === r.productId);
          const runStyle = r.nonInventoryStyle ?? p?.style;
          const runType = r.nonInventoryType ?? p?.type;
          if (!runStyle || !runType || !sameStyle(runStyle, tank.style)) continue;
          const unitLiters = p ? litersPerUnit(p) : runType === "crates" ? 24 * 0.33 : 20;
          legacyRemaining -= r.remaining * unitLiters;
          if (r.emptyTank || legacyRemaining < 20) {
            legacyCurrentEmptyDate = r.date!;
            break;
          }
        }
      }
      const emptyDate = canonicalCurrent.emptyDate ?? legacyCurrentEmptyDate;
      const remaining = emptyDate ? 0 : tank.liters;
      return {
        tankId: source.id,
        date: emptyDate ? nextBrewingWeek(emptyDate) : null,
        emptyDate,
        remaining,
        workLiters,
        reason: emptyDate
          ? legacyCurrentEmptyDate
            ? "לאחר ריקון המחזור הפיזי המתוכנן וניקיון חמישי"
            : "לאחר ריקון המחזור המתוכנן וניקיון חמישי"
          : "למחזור הנוכחי אין עדיין ריקון מתוכנן",
      };
    }

    let remaining = tank.liters;
    let emptyDate: string | null = null;
    for (const r of legacyRuns
      .filter((r) => canonicalRunTank(r as PackagingPlan, plans) === source.id)
      .sort((a, b) => a.date!.localeCompare(b.date!))) {
      const p = settings.products.find((p) => p.id === r.productId);
      const runStyle = r.nonInventoryStyle ?? p?.style;
      const runType = r.nonInventoryType ?? p?.type;
      if (!runStyle || !runType || !sameStyle(runStyle, tank.style)) continue;
      const unitLiters = p ? litersPerUnit(p) : runType === "crates" ? 24 * 0.33 : 20;
      remaining -= r.remaining * unitLiters;
      if (r.emptyTank || remaining < 20) {
        remaining = 0;
        emptyDate = r.date!;
        break;
      }
    }
    return {
      tankId: source.id,
      date: emptyDate ? nextBrewingWeek(emptyDate) : null,
      emptyDate,
      remaining: Math.max(0, remaining),
      workLiters,
      reason: emptyDate ? "לאחר ריקון legacy מתוכנן וניקיון חמישי" : "אין עדיין תוכנית לריקון המיכל",
    };
  });
}

export function normalizeEmptyTankFlagsForSchedule(plan: WeekPlan): WeekPlan {
  const packaging = plan.packaging.map((run) => ({ ...run }));
  const groups = new Map<string, Array<{ index: number; date?: string }>>();

  packaging.forEach((raw, index) => {
    const run = raw as PackagingPlan;
    const identity = run.brewId ? `brew:${run.brewId}` : run.tankId ? `legacy-tank:${run.tankId}` : "";
    if (!identity) return;
    const group = groups.get(identity) ?? [];
    group.push({ index, date: run.date });
    groups.set(identity, group);
  });

  for (const group of groups.values()) {
    const hadExplicitEmpty = group.some(({ index }) => packaging[index].emptyTank === true);
    if (!hadExplicitEmpty) continue;
    const ordered = [...group].sort((a, b) =>
      (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.index - b.index,
    );
    const lastIndex = ordered[ordered.length - 1]?.index;
    group.forEach(({ index }) => { packaging[index].emptyTank = index === lastIndex; });
  }
  return { ...plan, packaging };
}

export function validateProduction(
  plans: WeekPlan[],
  settings: Settings,
  tanks: Tank[],
  actuals: Actual[],
  today: string,
  options?: { allowEarlyPackaging?: boolean },
): string | null {
  const inventoryRuns = openRuns(plans, settings.products, actuals)
    .filter((r) => r.remaining > 0 && (!r.date || r.date >= today));
  const specialRuns = plans.flatMap((week) => (week.packaging ?? [])
    .filter((run) => !!run.nonInventoryStyle && !!run.nonInventoryType && run.quantity > 0 && (!run.date || run.date >= today))
    .map((run, index) => ({ ...run, remaining: run.quantity, week: week.id, key: run.id ?? `${week.id}:special:${index}` })));
  const runs = [...inventoryRuns, ...specialRuns]
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const tankRuns = new Map<string, { date: string; type: "crates" | "kegs" }[]>();
  const used = new Map<string, number>();

  for (const r of runs) {
    const linkedBrewId = resolvePackagingBrewId(r as PackagingPlan, plans);
    const linkedBrew = linkedBrewId ? brewById(plans, linkedBrewId) : null;
    const tankId = linkedBrew?.tankId ?? r.tankId;
    if (!tankId || !r.date) return "יש לשייך מיכל מקור ויום לכל אריזה עתידית";
    const t = tanks.find((t) => t.id === tankId);
    const p = settings.products.find((p) => p.id === r.productId);
    const runStyle = r.nonInventoryStyle ?? p?.style;
    const runType = r.nonInventoryType ?? p?.type;
    if (!t || !runStyle || !runType || !sameStyle(linkedBrew?.style ?? t.style, runStyle)) return "מיכל האריזה אינו תואם לסגנון";

    const projectedCycle = linkedBrewId
      ? projectTankSchedules(plans, settings).get(tankId)?.find((cycle) => cycle.cycleId === linkedBrewId)
      : null;
    const readyDate = projectedCycle?.readyDate ?? t.ready;
    if (r.date < readyDate && !r.earlyPackagingOverride && !options?.allowEarlyPackaging)
      return `מיכל ${t.number}: האריזה שובצה ל-${r.date} לפני מועד ההבשלה ${readyDate}`;

    const cycleKey = linkedBrewId ? `brew:${linkedBrewId}` : `legacy:${tankId}`;
    const history = tankRuns.get(cycleKey) ?? [];
    history.push({ date: r.date, type: runType });
    tankRuns.set(cycleKey, history);
    const dates = [...new Set(history.map((x) => x.date))];
    const types = new Set(history.map((x) => x.type));
    const allowExceptions = plans.find((w) => w.id === r.week)?.allowExceptions;
    if (!allowExceptions && dates.length > 1 && types.size < 2)
      return `מיכל ${t.number}: פיצול לימים שונים מותר רק בין בקבוקים לחביות`;
    if (!allowExceptions && dates.length > 2)
      return `מיכל ${t.number}: ניתן לפצל לכל היותר לשני ימי אריזה`;

    const unitLiters = p ? litersPerUnit(p) : runType === "crates" ? 24 * 0.33 : 20;
    used.set(cycleKey, (used.get(cycleKey) ?? 0) + r.remaining * unitLiters);
    const cycleLiters = linkedBrew?.liters ?? t.liters;
    if (used.get(cycleKey)! > cycleLiters + 0.01)
      return `מיכל ${t.number}: הכמות המתוכננת גדולה מהנפח הזמין במחזור`;
    if (r.emptyTank && cycleLiters - used.get(cycleKey)! >= 20)
      return `מיכל ${t.number}: לא ניתן לסמן סיום — נשארת כמות שניתנת לאריזה מהמחזור`;
  }
  return null;
}

export function validateBrewReleases(
  sources: TankSource[],
  tanks: Tank[],
  plans: WeekPlan[],
  settings: Settings,
  actuals: Actual[],
  today: string,
): string | null {
  const releases = tankReleases(sources, tanks, plans, settings, actuals, today);
  const schedules = projectTankSchedules(plans, settings);

  for (const b of plans.flatMap((w) => w.brews).filter((b) => b.date >= today)) {
    if (!b.tankId) continue;
    const tank = tanks.find((t) => t.id === b.tankId);
    const source = sources.find((s) => s.id === b.tankId);
    // Validate the FUTURE planned cycle against the tank's estimated brew
    // capacity for that style. source.beerVolume is the volume of the beer
    // physically in the tank now (e.g. after process/shrinkage) and must not
    // cap a later planned brew.
    const workLiters = estimatedBrewVolume(source?.tankNumber ?? tank?.number, b.style);
    if (!workLiters)
      return `למיכל ${source?.tankNumber ?? tank?.number ?? b.tankId} חסר נפח עבודה ולא ניתן היה לחשב אומדן`;
    if (b.liters > workLiters)
      return `מיכל ${source?.tankNumber ?? tank?.number ?? b.tankId}: תוכננו ${Math.round(b.liters)} ל׳, אבל נפח העבודה המחושב לבישול ${b.style} הוא ${Math.round(workLiters)} ל׳`;

    const cycles = orderedTankSchedule(schedules.get(b.tankId) ?? []).filter((cycle) => cycle.status !== "cancelled");
    const cycle = cycles.find((item) => item.cycleId === b.id);
    const readyDate = cycle?.readyDate ?? addDays(b.date, Math.max(
      ...settings.products.filter((p) => sameStyle(p.style, b.style)).map((p) => p.leadDays),
      21,
    ));
    if (!tankCanHostCycle(cycles, b.date, readyDate, b.id))
      return `בישול ${b.style}: המיכל תפוס על ידי מחזור אחר בחלון הבישול המתוכנן`;

    if (tank && tank.brewed === b.date && sameStyle(tank.style, b.style)) continue;
    const release = releases.find((r) => r.tankId === b.tankId);
    const requiredReleaseDate = b.availabilityOverride && release?.emptyDate
      ? addDays(release.emptyDate, 1)
      : release?.date;
    if (!requiredReleaseDate || b.date < requiredReleaseDate)
      return `בישול ${b.style}: תוכנית הריקון עדיין לא משחררת את המיכל בשבוע הזה`;
  }
  return null;
}