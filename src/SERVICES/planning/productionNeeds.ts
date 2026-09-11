import type { Pallet } from "../cooler/Pallettypes ";
import {
  addDays,
  brewAdvice,
  litersPerUnit,
  sameStyle,
  weeklyDemand,
  weekStart,
  type Actual,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import { futureTanks, openRuns, type DailyResult } from "./dailyPlanner";
import {
  packagingLimit,
  tankReleases,
  weekday,
  type TankSource,
} from "./productionCycle";
import type { BrewProposal } from "./brewScheduler";

export type ProductionNeed = {
  id: string;
  kind: "packaging" | "brew";
  date: string;
  neededBy: string;
  style: string;
  productId?: string;
  quantity: number;
  unit: string;
  reason: string;
  problem: string;
  nextTank?: {
    id: string;
    number: string;
    ready: string;
    firstDay: string;
    liters: number;
    reserved: boolean;
  };
};

export function productionDay(
  from: string,
  kind: ProductionNeed["kind"],
  holidays: Holiday[] = [],
): string {
  let day = from;
  while (
    (kind === "brew"
      ? weekday(day) < 1 || weekday(day) > 3
      : weekday(day) > 3) ||
    holidays.some((h) => h.closed && h.date === day)
  )
    day = addDays(day, 1);
  return day;
}

/** Demand survives resource shortages. These unresolved intentions NEVER create forecast supply. */
export function productionNeeds(
  settings: Settings,
  pallets: Pallet[],
  tanks: Tank[],
  effective: WeekPlan[],
  hypothetical: WeekPlan[],
  scenario: WeekPlan[],
  forecast: DailyResult,
  brewing: BrewProposal[],
  sources: TankSource[],
  actuals: Actual[],
  today: string,
  holidays: Holiday[],
): ProductionNeed[] {
  const result: ProductionNeed[] = [];
  const end = addDays(weekStart(today), 84);
  const dismissed = new Set(
    effective.flatMap((w) => w.dismissedRecommendations ?? []),
  );
  const pool = futureTanks(tanks, scenario, settings);
  const reserved = new Map<string, number>();
  for (const r of openRuns(effective, settings.products, actuals).filter(
    (r) => r.date && r.date >= today && r.tankId,
  )) {
    const p = settings.products.find((p) => p.id === r.productId);
    if (p)
      reserved.set(
        r.tankId!,
        (reserved.get(r.tankId!) ?? 0) + r.remaining * litersPerUnit(p),
      );
  }
  for (const action of forecast.suggestions.filter(
    (s) => s.kind === "packaging",
  ))
    for (const a of action.allocations)
      reserved.set(a.tankId, (reserved.get(a.tankId) ?? 0) + a.liters);

  // First determine the finished-product deficit. Only afterwards look for a source tank.
  for (const product of settings.products.filter((p) => p.monthly > 0)) {
    const target = weeklyDemand(product) * (settings.totalTargetWeeks ?? 8.5);
    const point = forecast.points.find(
      (p) =>
        p.productId === product.id &&
        p.tempo !== null &&
        p.brewery + p.tempo < target - 0.01 &&
        !dismissed.has(
          `need:packaging:${productionDay(p.date, "packaging", holidays)}:${product.id}`,
        ),
    );
    if (!point) continue;
    const date = productionDay(point.date, "packaging", holidays);
    if (date >= end) continue;
    const id = `need:packaging:${date}:${product.id}`;
    if (dismissed.has(id)) continue;
    const step = product.type === "crates" ? 84 : 1;
    const deficit = target - point.brewery - point.tempo!;
    const quantity = Math.min(
      packagingLimit(date, product.type),
      Math.ceil(deficit / step) * step,
    );
    const minimumLiters = step * litersPerUnit(product);
    const matching = pool
      .filter(
        (t) => sameStyle(t.style, product.style) && t.liters >= minimumLiters,
      )
      .map((t) => ({
        ...t,
        remaining: Math.max(0, t.liters - (reserved.get(t.id) ?? 0)),
      }));
    const fifo = (a: Tank, b: Tank) =>
      a.brewed.localeCompare(b.brewed) || a.id.localeCompare(b.id);
    const ready = matching
      .filter((t) => t.remaining >= minimumLiters && t.ready <= date)
      .sort(fifo)[0];
    const next =
      ready ??
      matching
        .filter((t) => t.remaining >= minimumLiters)
        .sort((a, b) => a.ready.localeCompare(b.ready) || fifo(a, b))[0] ??
      matching
        .filter((t) => t.ready >= date)
        .sort((a, b) => a.ready.localeCompare(b.ready) || fifo(a, b))[0] ??
      matching.sort(fifo)[0];
    result.push({
      id,
      kind: "packaging",
      date,
      neededBy: point.date,
      style: product.style,
      productId: product.id,
      quantity,
      unit: product.type === "crates" ? "ארגזים" : "חביות",
      reason: `נדרשת השלמת מלאי מוגמר ליעד הכיסוי · האריזה מוסיפה כ־${Math.floor(quantity / (weeklyDemand(product) / 7))} ימי מכירה`,
      problem: !next
        ? "אין מיכל מתאים עם יתרה פנויה; נדרש בישול או שינוי שיבוצים"
        : next.remaining < minimumLiters
          ? next.ready > date
            ? "המיכל הבא יבשיל אחרי המועד הנדרש וכבר מוקצה לאריזות אחרות"
            : "המיכל הבא כבר מוקצה לאריזות אחרות"
          : next.ready > date
            ? "אין מיכל מתאים בשל במועד הנדרש"
            : next.remaining < quantity * litersPerUnit(product)
              ? "המיכל מכסה רק חלק מהכמות; נדרש פיצול או מקור נוסף"
              : "נמצא מיכל מתאים; נדרש לבדוק יום עבודה פנוי ולשבץ",
      nextTank: next
        ? {
            id: next.id,
            number: next.number,
            ready: next.ready,
            firstDay: productionDay(
              [date, next.ready].sort().at(-1)!,
              "packaging",
              holidays,
            ),
            liters: next.remaining,
            reserved: next.remaining < minimumLiters,
          }
        : undefined,
    });
  }

  // Brewing demand is computed before looking for empty tanks; retain even a partially unmet need.
  const needs = brewAdvice(settings, pallets, tanks, hypothetical, today);
  const occupied = new Set(
    scenario
      .flatMap((w) => w.brews)
      .filter((b) => b.date >= today)
      .map((b) => b.tankId),
  );
  const releases = tankReleases(
    sources,
    tanks,
    hypothetical,
    settings,
    actuals,
    today,
  );
  for (const need of needs) {
    const remaining =
      need.liters -
      brewing
        .filter((b) => sameStyle(b.style, need.style))
        .reduce((sum, b) => sum + b.liters * 0.9, 0);
    if (remaining <= 0.01) continue;
    let date = productionDay(
      [today, need.brewBy].sort().at(-1)!,
      "brew",
      holidays,
    );
    while (date < end && dismissed.has(`need:brew:${date}:${need.style}`))
      date = productionDay(addDays(date, 1), "brew", holidays);
    if (date >= end) continue;
    const id = `need:brew:${date}:${need.style}`;
    if (dismissed.has(id)) continue;
    const next = releases
      .filter((r) => r.date && r.workLiters > 0 && !occupied.has(r.tankId))
      .sort(
        (a, b) =>
          a.date!.localeCompare(b.date!) || a.tankId.localeCompare(b.tankId),
      )[0];
    result.push({
      id,
      kind: "brew",
      date,
      neededBy: need.brewBy,
      style: need.style,
      quantity: Math.ceil(remaining / 0.9),
      unit: "ל׳ לבישול",
      reason:
        "הכמות הנוספת הדרושה לפי המכירות, המלאי המוגמר, הבירה בתהליך והבישולים שכבר הוצעו",
      problem: !next
        ? "אין מיכל פנוי עם נפח עבודה ומועד זמינות ידוע; נדרשת תוכנית ריקון"
        : next.date! > date
          ? "אין מיכל פנוי במועד הנדרש"
          : "נמצא מיכל; נדרש לתאם את הבישול עם ימי העבודה והשיבוצים",
      nextTank: next
        ? {
            id: next.tankId,
            number: String(
              sources.find((s) => s.id === next.tankId)?.tankNumber ??
                next.tankId,
            ),
            ready: next.date!,
            firstDay: productionDay(
              [date, next.date!].sort().at(-1)!,
              "brew",
              holidays,
            ),
            liters: next.workLiters,
            reserved: false,
          }
        : undefined,
    });
  }
  return result.sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
}
