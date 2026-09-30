import {
  addDays,
  brewAdvice,
  inventory,
  litersPerUnit,
  sameStyle,
  styleKey,
  weeklyDemand,
  weekStart,
  type Actual,
  type BrewPlan,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import type { Pallet } from "../cooler/Pallettypes ";
import { tankReleases, weekday, type TankSource } from "./productionCycle";
import { projectTankSchedules } from "./tankScheduleProjection";
import { tankCanHostCycle } from "./tankSchedule";

export type BrewProposal = BrewPlan & { reason: string; readyDate: string; dependent: boolean };

function firstBrewDay(from: string) {
  let date = from;
  while (weekday(date) < 1 || weekday(date) > 3) date = addDays(date, 1);
  return date;
}

export function brewProposals(
  settings: Settings,
  pallets: Pallet[],
  tanks: Tank[],
  plans: WeekPlan[],
  actuals: Actual[],
  sources: TankSource[],
  today: string,
): BrewProposal[] {
  const releases = tankReleases(sources, tanks, plans, settings, actuals, today);
  const schedules = projectTankSchedules(plans, settings);
  const booked = new Set<string>();
  const result: BrewProposal[] = [];
  const horizon = addDays(weekStart(today), 84);

  for (const need of brewAdvice(settings, pallets, tanks, plans, today).sort((a, b) => a.brewBy.localeCompare(b.brewBy))) {
    let remaining = need.liters;
    for (const release of releases.filter((r) => r.date && r.workLiters > 0 && !booked.has(r.tankId)).sort((a, b) => a.date!.localeCompare(b.date!))) {
      if (remaining <= 0) break;
      const date = firstBrewDay([today, release.date!].sort().at(-1)!);
      if (date >= horizon) continue;
      const lead = Math.max(...settings.products.filter((p) => sameStyle(p.style, need.style)).map((p) => p.leadDays), 21);
      if (!tankCanHostCycle(schedules.get(release.tankId) ?? [], date, addDays(date, lead))) continue;
      result.push({
        id: `brew:${release.tankId}:${date}:${need.style}`,
        tankId: release.tankId,
        style: need.style,
        date,
        liters: release.workLiters,
        readyDate: addDays(date, lead),
        dependent: !!release.emptyDate,
        reason: release.reason + (date > need.brewBy ? " · מאוחר ממועד הביקוש הרצוי" : date < need.brewBy ? " · מנצל מיכל פנוי מראש כדי למנוע מחסור עתידי" : ""),
      });
      remaining -= release.workLiters * 0.9;
      booked.add(release.tankId);
    }
  }

  const styleCandidates = [...new Set(settings.products.filter((p) => p.monthly > 0).map((p) => styleKey(p.style)))];
  const coverage = (key: string) => {
    const products = settings.products.filter((p) => styleKey(p.style) === key && p.monthly > 0);
    const demand = products.reduce((sum, p) => sum + weeklyDemand(p) * litersPerUnit(p), 0);
    if (!demand || products.some((p) => p.tempo === null)) return Infinity;
    const finished = products.reduce((sum, p) => {
      const inv = inventory(p, pallets);
      return sum + (inv.brewery + inv.dock + (p.tempo ?? 0)) * litersPerUnit(p);
    }, 0);
    const wip = tanks.filter((t) => styleKey(t.style) === key).reduce((sum, t) => sum + Math.max(0, t.liters), 0);
    const planned = [...plans.flatMap((w) => w.brews), ...result].filter((b) => styleKey(b.style) === key).reduce((sum, b) => sum + b.liters * 0.9, 0);
    return (finished + wip + planned) / demand;
  };

  for (const release of releases.filter((r) => r.date && r.workLiters > 0 && !booked.has(r.tankId)).sort((a, b) => a.date!.localeCompare(b.date!))) {
    const ranked = styleCandidates.map((key) => ({ key, cover: coverage(key) })).filter((x) => Number.isFinite(x.cover)).sort((a, b) => a.cover - b.cover);
    const chosen = ranked[0];
    if (!chosen) continue;
    const style = settings.products.find((p) => styleKey(p.style) === chosen.key && p.monthly > 0)?.style;
    if (!style) continue;
    const date = firstBrewDay([today, release.date!].sort().at(-1)!);
    if (date >= horizon) continue;
    const lead = Math.max(...settings.products.filter((p) => sameStyle(p.style, style)).map((p) => p.leadDays), 21);
    if (!tankCanHostCycle(schedules.get(release.tankId) ?? [], date, addDays(date, lead))) continue;
    result.push({
      id: `brew:${release.tankId}:${date}:${style}:coverage`,
      tankId: release.tankId,
      style,
      date,
      liters: release.workLiters,
      readyDate: addDays(date, lead),
      dependent: !!release.emptyDate,
      reason: `${release.reason} · המיכל מתפנה; ${style} הוא הסגנון עם כיסוי הייצור הנמוך ביותר לאחר התוכנית הקיימת`,
    });
    booked.add(release.tankId);
  }

  return result;
}