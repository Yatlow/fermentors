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
  // Legacy decisions sometimes store a physical tank number instead of its
  // Firestore document id. Only accept an unambiguous number match.
  const physicalRunTank = (run: PackagingPlan): string | undefined => {
    const linkedId = resolvePackagingBrewId(run, plans);
    if (linkedId) return brewById(plans, linkedId)?.tankId;
    const recorded = run.tankId;
    if (recorded && sources.some((source) => source.id === recorded)) return recorded;
    const number = run.tankNumber ?? recorded;
    if (number == null) return undefined;
    const matches = sources.filter((source) =>
      source.tankNumber != null && String(source.tankNumber) === String(number));
    return matches.length === 1 ? matches[0].id : undefined;
  };
  const belongsToCurrentBatch = (run: PackagingPlan, source: TankSource) =>
    physicalRunTank(run) === source.id &&
    normalizedBatch(source.batchNumber) !== "" &&
    normalizedBatch(run.batchNumber) === normalizedBatch(source.batchNumber);


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
    // A matching batch is stronger evidence than a matching brew date.
    // Do not allow a future cycle with the same date to shadow the physical
    // batch, or an unrelated future cycle to become the current one.
    const matchingBatch = sourceBatch
      ? [...cycles].reverse().find((cycle) =>
          normalizedBatch(cycle.batchNumber ?? cycle.plannedBatchNumber) === sourceBatch)
      : undefined;
    // Historical canonical brews may predate assignment of a batch number.
    // Match their exact brew date only when the cycle has no conflicting batch.
    const matchingDate = sourceBrewDate
      ? [...cycles].reverse().find((cycle) =>
          cycle.brewDate === sourceBrewDate &&
          (!normalizedBatch(cycle.batchNumber ?? cycle.plannedBatchNumber) ||
            normalizedBatch(cycle.batchNumber ?? cycle.plannedBatchNumber) === sourceBatch))
      : undefined;
    const canonicalCurrent = matchingBatch ?? matchingDate;
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
            belongsToCurrentBatch(run as PackagingPlan, source))
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
      .filter((r) => physicalRunTank(r as PackagingPlan) === source.id &&
        (!sourceBatch || belongsToCurrentBatch(r as PackagingPlan, source)))
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
    // Prefer explicit canonical identity, but scheduling a packaging day may be
    // the first edit that turns an approved future packaging decision into a
    // dated row. Older recommendation/save paths can therefore arrive here
    // without brewId even though the source is an unambiguous planned brew.
    // Resolve that narrow case from tank + style + chronology before treating
    // it as legacy physical-tank packaging.
    const explicitBrewId = resolvePackagingBrewId(r as PackagingPlan, plans);
    const product = settings.products.find((candidate) => candidate.id === r.productId);
    const runStyle = r.nonInventoryStyle ?? product?.style;
    // A packaging decision for the batch physically in the tank must not
    // inherit a future planned brew merely because it shares tank and style.
    const physicalTank = tanks.find((tank) =>
      tank.id === r.tankId ||
      (!!r.tankNumber && String(tank.number) === String(r.tankNumber))
    );
    const belongsToPhysicalBatch = !!physicalTank &&
      !!r.batchNumber &&
      normalizedBatch(r.batchNumber) === normalizedBatch(physicalTank.batch);
    const inferredBrew = !explicitBrewId && !belongsToPhysicalBatch && r.tankId && r.date && runStyle
      ? plans
          .flatMap((week) => week.brews ?? [])
          .filter((brew) =>
            brew.tankId === r.tankId &&
            brew.date <= r.date! &&
            sameStyle(brew.style, runStyle)
          )
          .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
          .at(-1) ?? null
      : null;
    const linkedBrewId = explicitBrewId ?? inferredBrew?.id ?? null;
    const linkedBrew = linkedBrewId ? brewById(plans, linkedBrewId) : null;
    // Older packaging decisions can carry a tank number (or a numeric
    // tankId) rather than the Firestore document id. Resolve only an
    // unambiguous physical match; never redirect an explicit brew cycle.
    const recordedTankId = linkedBrew?.tankId ?? r.tankId;
    const matchedTank = tanks.find((tank) => tank.id === recordedTankId);
    const recordedNumber = r.tankNumber ?? recordedTankId;
    const numberMatches = !linkedBrew && recordedNumber != null
      ? tanks.filter((tank) => String(tank.number) === String(recordedNumber))
      : [];
    const t = matchedTank ?? (numberMatches.length === 1 ? numberMatches[0] : undefined);
    const tankId = linkedBrew?.tankId ?? t?.id ?? recordedTankId;
    if (!tankId || !r.date) return "יש לשייך מיכל מקור ויום לכל אריזה עתידית";
    const p = settings.products.find((p) => p.id === r.productId);
    const runType = r.nonInventoryType ?? p?.type;
    if (!linkedBrew && !t) return "חסר מיכל מקור לאריזה";

    const projectedCycle = linkedBrewId
      ? projectTankSchedules(plans, settings).get(tankId)?.find((cycle) => cycle.cycleId === linkedBrewId)
      : null;
    const fallbackLeadDays = linkedBrew
      ? Math.max(21, ...settings.products.filter((product) => sameStyle(product.style, linkedBrew.style)).map((product) => product.leadDays))
      : 0;
    const readyDate = projectedCycle?.readyDate
      ?? (linkedBrew ? addDays(linkedBrew.date, fallbackLeadDays) : t?.ready ?? "");
    const tankLabel = t?.number ?? linkedBrew?.tankId ?? tankId;
    if (readyDate && r.date < readyDate && !r.earlyPackagingOverride && !options?.allowEarlyPackaging)
      return `מיכל ${tankLabel}: האריזה שובצה ל-${r.date} לפני מועד ההבשלה ${readyDate}`;

    // During scheduling the planner can place the future brew on a packaging day
    // before choosing crates/kegs. Type-dependent validation is deferred until
    // the packaging product/type is actually defined.
    if (!runType) continue;

    const cycleKey = linkedBrewId ? `brew:${linkedBrewId}` : `legacy:${tankId}`;
    const history = tankRuns.get(cycleKey) ?? [];
    history.push({ date: r.date, type: runType });
    tankRuns.set(cycleKey, history);
    const dates = [...new Set(history.map((x) => x.date))];
    const types = new Set(history.map((x) => x.type));
    const allowExceptions = plans.find((w) => w.id === r.week)?.allowExceptions;
    if (!allowExceptions && dates.length > 1 && types.size < 2)
      return `מיכל ${tankLabel}: פיצול לימים שונים מותר רק בין בקבוקים לחביות`;
    if (!allowExceptions && dates.length > 2)
      return `מיכל ${tankLabel}: ניתן לפצל לכל היותר לשני ימי אריזה`;

    const unitLiters = p ? litersPerUnit(p) : runType === "crates" ? 24 * 0.33 : 20;
    used.set(cycleKey, (used.get(cycleKey) ?? 0) + r.remaining * unitLiters);
    // A future canonical brew's declared volume is its original volume.
    // Subtract already packaged units before validating pending decisions.
    // A physical current tank's liters are already net of its past packaging.
    const isCurrentPhysicalCycle = !!linkedBrew && !!t &&
      normalizedBatch(linkedBrew.batchNumber) !== "" &&
      normalizedBatch(t.batch) === normalizedBatch(linkedBrew.batchNumber);
    const packedLiters = linkedBrew && !isCurrentPhysicalCycle
      ? actuals.filter((actual) => {
          const packedDate = actualDate(actual);
          return packedDate && packedDate >= linkedBrew.date && packedDate <= today &&
            String(actual.tankNumber ?? "") === String(t?.number ?? "") &&
            normalizedBatch(actual.batchNumber) === normalizedBatch(linkedBrew.batchNumber) &&
            sameStyle(actual.beerStyle ?? "", linkedBrew.style);
        }).reduce((sum, actual) => {
          const isCrates = actual.packagingType === "bottles";
          const units = num(actual.quantity) / (isCrates && actual.unit === "בקבוקים" ? 24 : 1);
          return sum + units * (isCrates ? 24 * 0.33 : 20);
        }, 0)
      : 0;
    const cycleLiters = isCurrentPhysicalCycle
      ? t!.liters
      : linkedBrew ? Math.max(0, linkedBrew.liters - packedLiters) : t?.liters ?? 0;
    if (!cycleLiters) return `מיכל ${tankLabel}: חסר נפח מחזור לחישוב האריזה`;
    if (used.get(cycleKey)! > cycleLiters + 0.01)
      return `מיכל ${tankLabel}: הכמות המתוכננת גדולה מהנפח הזמין במחזור`;
    // For the current physical batch, an explicit planned emptying is an
    // operational decision, not a claim that estimated liters exactly match
    // packed units. Beer may be lost to shrinkage or discarded at emptying.
    // Still reject plans that exceed available liters, and retain the strict
    // residual-volume rule for every future canonical cycle.
    const physicalBatchIdentity = normalizedBatch(r.batchNumber || linkedBrew?.batchNumber);
    const sameDeclaredPhysicalBatch = !!t && physicalBatchIdentity !== "" &&
      normalizedBatch(t.batch) === physicalBatchIdentity &&
      (!linkedBrew || !normalizedBatch(linkedBrew.batchNumber) ||
        normalizedBatch(linkedBrew.batchNumber) === physicalBatchIdentity);
    // Historical current-cycle decisions sometimes lack a batch snapshot.
    // The physical brew date is a safe fallback only if no declared batch
    // conflicts, and never for a packaging row dated after a later brew.
    const noConflictingBatch = !!t &&
      (!normalizedBatch(r.batchNumber) || normalizedBatch(r.batchNumber) === normalizedBatch(t.batch)) &&
      (!linkedBrew || !normalizedBatch(linkedBrew.batchNumber) ||
        normalizedBatch(linkedBrew.batchNumber) === normalizedBatch(t.batch));
    const matchingPhysicalDate = !!linkedBrew && !!t &&
      linkedBrew.date === t.brewed &&
      sameStyle(linkedBrew.style, t.style);
    const nextBrewAlreadyStarted = plans.some((week) => (week.brews ?? []).some((brew) =>
      brew.tankId === tankId && brew.date > (t?.brewed ?? "") &&
      brew.date <= r.date! &&
      (!linkedBrew || brew.id !== linkedBrew.id)));
    const inferredPhysicalLegacy = !linkedBrew && !!t && !String(t.id).startsWith("planned:") &&
      !!t.brewed && r.date! >= t.brewed &&
      !!runStyle && sameStyle(runStyle, t.style);
    const currentPhysicalBatch = noConflictingBatch &&
      (sameDeclaredPhysicalBatch || matchingPhysicalDate || inferredPhysicalLegacy) &&
      !nextBrewAlreadyStarted;
    if (r.emptyTank && !currentPhysicalBatch && cycleLiters - used.get(cycleKey)! >= 20)
      return `מיכל ${tankLabel}: לא ניתן לסמן סיום — נשארת כמות שניתנת לאריזה מהמחזור`;
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