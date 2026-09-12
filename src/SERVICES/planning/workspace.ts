import type { Pallet } from "../cooler/Pallettypes ";
import { MAX_TRUCK_SLOTS } from "../cooler/truckCapacity";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  sameStyle,
  weekStart,
  type Actual,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import { dailyForecast, type DailySuggestion, type ShipmentEvent } from "./dailyPlanner";
import { brewProposals, type BrewProposal } from "./brewScheduler";
import { productionNeeds } from "./productionNeeds";
import type { TankSource } from "./productionCycle";

export type PlanningAction =
  | (DailySuggestion & { status: "recommended" })
  | (BrewProposal & { kind: "brew"; status: "recommended" });

export function suggestedDispatchDate(today: string): string {
  const start = weekStart(today);
  return today <= addDays(start, 2) ? today : addDays(start, 7);
}

export function withMarkedDeliveries(plans: WeekPlan[], pallets: Pallet[], settings: Settings, today: string): WeekPlan[] {
  const result = structuredClone(plans);
  const assigned = new Set(plans.flatMap((w) => w.deliveries ?? []).flatMap((d) => d.pallets ?? []).map((p) => p.id));
  const inferred = suggestedDispatchDate(today);
  const weekId = weekStart(inferred);
  let week = result.find((w) => w.id === weekId);
  if (!week) { week = emptyWeek(weekId); result.push(week); }
  const date = week.deliveryDates?.filter((d) => d >= today).sort()[0] ?? inferred;
  for (const p of settings.products) {
    const selected = pallets.filter((x) => x.markedForShipment && x.zone !== "shipped" && !assigned.has(x.id) && x.itemType === p.type && sameStyle(x.beerStyle, p.style));
    if (!selected.length) continue;
    week.deliveries ??= [];
    week.deliveries.push({ id: `marked:${p.id}:${date}`, productId: p.id, quantity: selected.reduce((sum, x) => sum + x.quantity, 0), dispatchDate: date, arrivalDate: date, truckId: `marked:${date}`, pallets: selected });
  }
  return result;
}

function fullTruckSuggestions(suggestions: DailySuggestion[]) {
  const truckSlots = new Map<string, number>();
  for (const s of suggestions) {
    if (s.kind !== "delivery") continue;
    const key = s.truckId ?? s.date;
    truckSlots.set(key, Math.max(truckSlots.get(key) ?? 0, s.slots ?? 0));
  }
  return suggestions.filter((s) => s.kind !== "delivery" || (truckSlots.get(s.truckId ?? s.date) ?? 0) >= MAX_TRUCK_SLOTS);
}

export function planningWorkspace(
  settings: Settings,
  pallets: Pallet[],
  tanks: Tank[],
  plans: WeekPlan[],
  actuals: Actual[],
  sources: TankSource[],
  today: string,
  holidays: Holiday[],
  shipments: ShipmentEvent[],
) {
  const effectivePlans = withMarkedDeliveries(plans, pallets, settings, today);
  const first = dailyForecast(settings, pallets, tanks, effectivePlans, actuals, today, holidays, true, shipments);
  const hypothetical = structuredClone(effectivePlans);
  for (const s of first.suggestions.filter((s) => s.kind === "packaging")) {
    const id = weekStart(s.date);
    let week = hypothetical.find((w) => w.id === id);
    if (!week) { week = emptyWeek(id); hypothetical.push(week); }
    week.packaging.push({ id: s.id, productId: s.productId, date: s.date, quantity: s.quantity, tankId: s.allocations[0]?.tankId, source: "recommendation" });
  }
  for (const tank of tanks) {
    const runs = hypothetical.flatMap((w) => w.packaging).filter((r) => r.tankId === tank.id && r.date! >= today).sort((a, b) => a.date!.localeCompare(b.date!));
    const liters = runs.reduce((sum, r) => {
      const p = settings.products.find((p) => p.id === r.productId);
      return sum + (p ? r.quantity * litersPerUnit(p) : 0);
    }, 0);
    if (runs.length && tank.liters - liters >= -0.01 && tank.liters - liters < 20) runs[runs.length - 1].emptyTank = true;
  }

  const dismissed = new Set(plans.flatMap((w) => w.dismissedRecommendations ?? []));
  const brewing = brewProposals(settings, pallets, tanks, hypothetical, actuals, sources, today).filter((b) => !dismissed.has(b.id) && !holidays.some((h) => h.closed && h.date === b.date));
  const scenario = structuredClone(effectivePlans);
  for (const b of brewing) {
    const id = weekStart(b.date);
    let week = scenario.find((w) => w.id === id);
    if (!week) { week = emptyWeek(id); scenario.push(week); }
    week.brews.push({ id: b.id, style: b.style, tankId: b.tankId, date: b.date, liters: b.liters });
  }

  const rawForecast = dailyForecast(settings, pallets, tanks, scenario, actuals, today, holidays, true, shipments);
  const forecast = { ...rawForecast, suggestions: fullTruckSuggestions(rawForecast.suggestions) };
  const actions: PlanningAction[] = [
    ...forecast.suggestions.map((s) => ({ ...s, status: "recommended" as const })),
    ...brewing.map((b) => ({ ...b, kind: "brew" as const, status: "recommended" as const })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const needs = productionNeeds(settings, pallets, tanks, effectivePlans, hypothetical, scenario, forecast, brewing, sources, actuals, today, holidays);
  return { effectivePlans, forecast, actions, hypothetical, scenario, needs };
}

export function adoptAction(week: WeekPlan, action: PlanningAction): WeekPlan {
  const next = structuredClone(week);
  next.dismissedRecommendations = [...new Set([...(next.dismissedRecommendations ?? []), action.id])];
  if (action.kind === "brew") {
    next.brews.push({ id: action.id, tankId: action.tankId, style: action.style, date: action.date, liters: action.liters });
  } else if (action.kind === "packaging") {
    next.packaging.push({ id: action.id, productId: action.productId, date: action.date, quantity: action.quantity, tankId: action.allocations[0]?.tankId ?? "", source: "recommendation" });
  } else {
    next.deliveries ??= [];
    next.deliveries.push({ id: action.id, productId: action.productId, quantity: action.quantity, dispatchDate: action.date, arrivalDate: action.date, truckId: action.truckId ?? action.id, pallets: action.pallets ?? [] });
  }
  return next;
}
