import {
  addDays,
  litersPerUnit,
  num,
  sameStyle,
  weekStart,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import { actualDate, openRuns } from "./dailyPlanner";
import type { Actual } from "./planningEngine";
export const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).getUTCDay();
export const nextBrewingWeek = (emptied: string) =>
  addDays(weekStart(emptied), 8);
export const packagingLimit = (date: string, type: "crates" | "kegs") =>
  weekday(date) === 0
    ? type === "crates"
      ? 168
      : 100
    : type === "crates"
      ? 252
      : Infinity;
export type TankSource = {
  id: string;
  tankNumber?: string | number | null;
  beerVolume?: unknown;
  tankStatus?: unknown;
  stage?: { className?: string };
};
export type Release = {
  tankId: string;
  date: string | null;
  emptyDate: string | null;
  remaining: number;
  workLiters: number;
  reason: string;
};
/** Only explicit tank-linked, remaining runs can release a currently occupied tank. */
export function tankReleases(
  sources: TankSource[],
  tanks: Tank[],
  plans: WeekPlan[],
  settings: Settings,
  actuals: Actual[],
  today: string,
): Release[] {
  const runs = openRuns(plans, settings.products, actuals).filter(
    (r) => r.date && r.date >= today && r.remaining > 0,
  );
  return sources.map((source) => {
    const workLiters = num(source.beerVolume);
    if (
      source.tankStatus === true ||
      ["stage-empty", "stage-clean", "stage-sanitized"].includes(
        source.stage?.className ?? "",
      )
    ) {
      const packedThisWeek = actuals
        .filter(
          (a) =>
            source.tankNumber != null &&
            String(a.tankNumber) === String(source.tankNumber),
        )
        .map(actualDate)
        .filter(
          (date): date is string =>
            !!date && date >= weekStart(today) && date <= today,
        )
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
          : "פנוי בדאשבורד — יש לאמת ניקיון וחיטוי",
      };
    }
    const tank = tanks.find((t) => t.id === source.id);
    if (!tank)
      return {
        tankId: source.id,
        date: null,
        emptyDate: null,
        remaining: 0,
        workLiters,
        reason: "חסרים נתוני מיכל מאומתים",
      };
    let remaining = tank.liters,
      emptyDate: string | null = null;
    for (const r of runs
      .filter((r) => r.tankId === source.id)
      .sort((a, b) => a.date!.localeCompare(b.date!))) {
      const p = settings.products.find((p) => p.id === r.productId);
      if (!p || !sameStyle(p.style, tank.style) || r.date! < tank.ready)
        continue;
      remaining -= r.remaining * litersPerUnit(p);
      if (remaining <= 0.01 || (r.emptyTank && remaining < 20)) {
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
      reason: emptyDate
        ? "לאחר ריקון מתוכנן וניקיון חמישי; שארית קטנה מ־20 ל׳ מחייבת אישור"
        : "אין עדיין תוכנית לריקון המיכל",
    };
  });
}
export function validateProduction(
  plans: WeekPlan[],
  settings: Settings,
  tanks: Tank[],
  actuals: Actual[],
  today: string,
): string | null {
  const runs = openRuns(plans, settings.products, actuals)
    .filter((r) => r.remaining > 0 && (!r.date || r.date >= today))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const dates = new Map<string, Set<string>>(),
    used = new Map<string, number>();
  for (const r of runs) {
    if (!r.tankId || !r.date) return "יש לשייך מיכל מקור ויום לכל אריזה עתידית";
    const t = tanks.find((t) => t.id === r.tankId),
      p = settings.products.find((p) => p.id === r.productId);
    if (!t || !p || !sameStyle(t.style, p.style) || r.date! < t.ready)
      return "מיכל האריזה אינו תואם לסגנון או טרם הבשיל";
    const ds =
      dates.get(t.id) ??
      new Set<string>(
        actuals
          .filter(
            (a) =>
              String(a.tankNumber) === t.number &&
              String(a.batchNumber) === t.batch,
          )
          .map(actualDate)
          .filter((d): d is string => !!d && d >= t.brewed),
      );
    ds.add(r.date!);
    dates.set(t.id, ds);
    if (ds.size > 2 && !plans.find((w) => w.id === r.week)?.allowExceptions)
      return `מיכל ${t.number}: ניתן לפצל לכל היותר לשני ימי אריזה`;
    used.set(t.id, (used.get(t.id) ?? 0) + r.remaining * litersPerUnit(p));
    if (used.get(t.id)! > t.liters + 0.01)
      return `מיכל ${t.number}: הכמות המתוכננת גדולה מהנפח הזמין לאחר פחת`;
    if (r.emptyTank && t.liters - used.get(t.id)! >= 20)
      return `מיכל ${t.number}: לא ניתן לסמן סיום כשנותרו 20 ליטר ומעלה`;
  }
  return null;
}

/** Recheck ALL downstream bookings when an earlier packaging week changes. */
export function validateBrewReleases(
  sources: TankSource[],
  tanks: Tank[],
  plans: WeekPlan[],
  settings: Settings,
  actuals: Actual[],
  today: string,
): string | null {
  const releases = tankReleases(
    sources,
    tanks,
    plans,
    settings,
    actuals,
    today,
  );
  for (const b of plans
    .flatMap((w) => w.brews)
    .filter((b) => b.date >= today)) {
    if (
      tanks.some(
        (t) =>
          t.id === b.tankId &&
          t.brewed === b.date &&
          sameStyle(t.style, b.style),
      )
    )
      continue;
    const release = releases.find((r) => r.tankId === b.tankId);
    if (!release?.date || b.date < release.date)
      return `בישול ${b.style} ב־${b.date}: תוכנית הריקון אינה מאפשרת את זמינות המיכל`;
    if (!release.workLiters || b.liters > release.workLiters)
      return "נפח עבודה חסר או חריגה מנפח המיכל בדאשבורד";
  }
  return null;
}
