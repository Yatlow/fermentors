import type { Fermentor } from "../../App";
import type { Pallet } from "../cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  sameStyle,
  weeklyDemand,
  weekStart,
  type Actual,
  type Holiday,
  type Product,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import {
  actualDate,
  dailyForecast,
  openRuns,
  type DailyResult,
  type ShipmentEvent,
} from "./dailyPlanner";
import { buildShipmentRecommendation } from "./shipmentRecommendation";
import { tankReleases } from "./productionCycle";
import { displayStyle, isCoreStyle } from "./planningPresentation";

export type WeeklyStage = "base" | "afterShipment" | "afterPackaging" | "committed";

export type WeeklySkuState = {
  product: Product;
  tempoUnits: number | null;
  breweryUnits: number;
  tempoCover: number | null;
  totalCover: number | null;
};

export type WeeklyShipmentRecommendation = {
  productId: string;
  quantity: number;
  pallets: number;
  slots: number;
};

export type WeeklyPackagingRecommendation = {
  id: string;
  productId: string;
  quantity: number;
  tankId: string;
  tankNumber: string;
  liters: number;
  dayCost: number;
};

export type BrewSizeLabel = "בודד" | "כפול" | "משולש";

export type WeeklyBrewRecommendation = {
  style: string;
  liters: number;
  sizeLabel: BrewSizeLabel;
};

export type WeeklyPlanningModel = {
  week: string;
  weekEnd: string;
  forecasts: Record<WeeklyStage, DailyResult>;
  rows: Record<WeeklyStage, Map<string, WeeklySkuState>>;
  shipmentRecommendation: WeeklyShipmentRecommendation[];
  shipmentSlots: number;
  shipmentCanFillTruck: boolean;
  packagingRecommendation: WeeklyPackagingRecommendation[];
  packagingDays: number;
  packagingCapacity: number;
  brewRecommendations: WeeklyBrewRecommendation[];
  /** Remaining tank positions after decisions already saved for the selected week. */
  availableBrewTanks: number;
  /** Tank capacity available at the start of the selected week, before that week's decisions. */
  brewTankCapacity: number;
  tankAvailableLiters: Map<string, number>;
};

function forecastSettings(settings: Settings, today: string): Settings {
  return {
    ...settings,
    products: settings.products.map((p) => ({
      ...p,
      tempoDate: p.tempo === null ? p.tempoDate : today,
    })),
  };
}

function dateWeeklyPackaging(plans: WeekPlan[]): WeekPlan[] {
  return plans.map((week) => {
    const next = structuredClone(week);
    const dispatch = [...(next.deliveries ?? [])]
      .map((d) => d.dispatchDate)
      .filter((date) => date >= week.id && date <= addDays(week.id, 6))
      .sort()[0];
    const forecastDate = dispatch ?? addDays(week.id, 4);
    next.packaging = next.packaging.map((run) =>
      run.date ? run : { ...run, date: forecastDate },
    );
    return next;
  });
}

function plansAtStage(plans: WeekPlan[], week: string, stage: WeeklyStage): WeekPlan[] {
  const source = plans.some((w) => w.id === week) ? plans : [...plans, emptyWeek(week)];
  return source.map((w) => {
    if (w.id !== week) return structuredClone(w);
    const next = structuredClone(w);
    if (stage === "base") {
      next.deliveries = [];
      next.deliveryDates = [];
      next.packaging = [];
      next.brews = [];
    } else if (stage === "afterShipment") {
      next.packaging = [];
      next.brews = [];
    } else if (stage === "afterPackaging") {
      next.brews = [];
    }
    next.dismissedRecommendations = [];
    return next;
  });
}

function pointAt(result: DailyResult, productId: string, date: string) {
  return result.points
    .filter((p) => p.productId === productId && p.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

function skuRows(settings: Settings, result: DailyResult, date: string) {
  const map = new Map<string, WeeklySkuState>();
  for (const product of settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style))) {
    const point = pointAt(result, product.id, date);
    const demand = weeklyDemand(product);
    const tempoUnits = point?.tempo ?? null;
    const breweryUnits = point?.brewery ?? 0;
    map.set(product.id, {
      product,
      tempoUnits,
      breweryUnits,
      tempoCover: tempoUnits === null || demand <= 0 ? null : tempoUnits / demand,
      totalCover: tempoUnits === null || demand <= 0 ? null : (tempoUnits + breweryUnits) / demand,
    });
  }
  return map;
}

function remainingTankLiters(
  tank: Tank,
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  selectedWeek: string,
) {
  let liters = tank.liters;
  const priorPlans = plans.map((w) =>
    w.id === selectedWeek ? { ...w, packaging: [] } : w,
  );
  for (const run of openRuns(priorPlans, products, actuals)) {
    if (run.remaining <= 0 || !run.tankId || run.tankId !== tank.id || run.week >= selectedWeek) continue;
    const p = products.find((x) => x.id === run.productId);
    if (p) liters -= run.remaining * litersPerUnit(p);
  }
  return Math.max(0, liters);
}

function buildPackagingRecommendation(
  settings: Settings,
  rows: Map<string, WeeklySkuState>,
  tanks: Tank[],
  plans: WeekPlan[],
  actuals: Actual[],
  week: string,
  weekEnd: string,
) {
  const products = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const target = settings.totalTargetWeeks ?? settings.targetWeeks;
  const actualDays = new Set(
    actuals.map(actualDate).filter((d): d is string => !!d && d >= week && d <= weekEnd),
  );
  const capacity = Math.max(
    0,
    (plans.find((w) => w.id === week)?.maxRuns ?? settings.preferredRuns) - actualDays.size,
  );
  const candidates: WeeklyPackagingRecommendation[] = [];

  for (const tank of tanks) {
    if (tank.ready > weekEnd) continue;
    const liters = remainingTankLiters(tank, plans, products, actuals, week);
    if (liters < 20) continue;

    for (const p of products.filter((x) => sameStyle(x.style, tank.style))) {
      const state = rows.get(p.id);
      if (!state || state.totalCover === null || state.totalCover >= target) continue;

      const fullQuantity = Math.floor((liters + 1e-8) / litersPerUnit(p));
      let quantity = fullQuantity;
      if (p.type === "crates") {
        const normal = Math.min(252, fullQuantity);
        const residual = Math.max(0, liters - normal * litersPerUnit(p));
        const ratio = liters > 0 ? residual / liters : 0;
        const finishTank = fullQuantity > 252 && fullQuantity <= 270 && ratio < 0.07;
        quantity = finishTank ? fullQuantity : normal;
      }
      if (quantity <= 0) continue;

      candidates.push({
        id: `weekly-pack:${week}:${tank.id}:${p.id}`,
        productId: p.id,
        quantity,
        tankId: tank.id,
        tankNumber: String(tank.number),
        liters,
        dayCost: p.type === "crates" ? 1 : quantity / 150,
      });
    }
  }

  const selected: WeeklyPackagingRecommendation[] = [];
  const usedTanks = new Set<string>();
  const virtualCover = new Map<string, number>();
  for (const p of products) virtualCover.set(p.id, rows.get(p.id)?.totalCover ?? Infinity);

  const daysNeeded = (items: WeeklyPackagingRecommendation[]) => {
    const crateRuns = items.filter((x) => products.find((p) => p.id === x.productId)?.type === "crates").length;
    const totalKegs = items.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.productId);
      return sum + (p?.type === "kegs" ? item.quantity : 0);
    }, 0);
    return crateRuns + (totalKegs > 0 ? Math.ceil(totalKegs / 150) : 0);
  };

  while (true) {
    const choices = candidates
      .filter((c) => !usedTanks.has(c.tankId))
      .filter((c) => (virtualCover.get(c.productId) ?? Infinity) < target)
      .sort((a, b) =>
        (virtualCover.get(a.productId) ?? Infinity) - (virtualCover.get(b.productId) ?? Infinity),
      );
    const next = choices.find((c) => daysNeeded([...selected, c]) <= capacity);
    if (!next) break;

    selected.push(next);
    usedTanks.add(next.tankId);
    const p = products.find((x) => x.id === next.productId)!;
    virtualCover.set(
      p.id,
      (virtualCover.get(p.id) ?? 0) + next.quantity / weeklyDemand(p),
    );
  }

  return { recommendation: selected, days: daysNeeded(selected), capacity };
}

function brewSizeForTankNumber(value: unknown, liters: number): BrewSizeLabel {
  const tankNumber = Number(value);
  if (Number.isFinite(tankNumber)) {
    if (tankNumber >= 2 && tankNumber <= 4) return "בודד";
    if (tankNumber >= 5 && tankNumber <= 8) return "כפול";
    if (tankNumber >= 9) return "משולש";
  }
  if (liters <= 1500) return "בודד";
  if (liters <= 2800) return "כפול";
  return "משולש";
}

function buildBrewRecommendation(
  settings: Settings,
  rows: Map<string, WeeklySkuState>,
  tanks: Tank[],
  plans: WeekPlan[],
  actuals: Actual[],
  sources: Fermentor[],
  today: string,
  week: string,
  weekEnd: string,
) {
  const planningStart = weekStart(today);
  const currentWeek = plans.find((w) => w.id === week);
  const occupiedTankIds = new Set(
    plans
      .filter((w) => w.id >= planningStart && w.id <= week)
      .flatMap((w) => w.brews)
      .filter((b) => !!b.tankId && b.date <= weekEnd)
      .map((b) => b.tankId),
  );

  const releases = tankReleases(sources, tanks, plans, settings, actuals, today)
    .filter((r) => !!r.date && r.date! <= weekEnd && !occupiedTankIds.has(r.tankId))
    .sort((a, b) =>
      (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31") ||
      Number(sources.find((s) => s.id === a.tankId)?.tankNumber ?? Infinity) -
        Number(sources.find((s) => s.id === b.tankId)?.tankNumber ?? Infinity),
    );

  // Unassigned weekly brew decisions still reserve a tank even before the daily
  // board assigns a concrete tank id. Keep reservations from earlier planned weeks
  // in the same planning horizon, otherwise week N+1 incorrectly sees those tanks
  // as free again (e.g. 3 brews in week 38 + 2 emptied tanks => week 39 has 2 free,
  // not 5).
  const priorUnassigned = plans
    .filter((w) => w.id >= planningStart && w.id < week)
    .flatMap((w) => w.brews)
    .filter((b) => !b.tankId && b.date <= weekEnd).length;
  const currentUnassigned = currentWeek?.brews.filter((b) => !b.tankId && b.date <= weekEnd).length ?? 0;
  const currentAssigned = currentWeek?.brews.filter((b) => !!b.tankId && b.date <= weekEnd).length ?? 0;

  // `releases` already excludes assigned current-week tanks, therefore add them
  // back only when calculating capacity before this week's own decisions.
  const capacityBeforeCurrent = Math.max(0, releases.length + currentAssigned - priorUnassigned);
  const remainingCapacity = Math.max(0, releases.length - priorUnassigned - currentUnassigned);

  const anonymousReservations = Math.min(releases.length, priorUnassigned + currentUnassigned);
  const availableReleases = releases.slice(anonymousReservations);

  const styles = [
    ...new Set(
      settings.products
        .filter((p) => p.monthly > 0 && isCoreStyle(p.style))
        .map((p) => displayStyle(p.style)),
    ),
  ];
  const ranked = styles
    .map((style) => {
      const productRows = [...rows.values()].filter((r) => sameStyle(r.product.style, style));
      const covers = productRows
        .map((r) => r.totalCover)
        .filter((value): value is number => value !== null);
      return { style, cover: covers.length ? Math.min(...covers) : Infinity };
    })
    .sort((a, b) => a.cover - b.cover);

  const recommendations: WeeklyBrewRecommendation[] = [];
  for (let i = 0; i < Math.min(remainingCapacity, ranked.length, availableReleases.length); i++) {
    const release = availableReleases[i];
    const source = sources.find((s) => s.id === release.tankId);
    recommendations.push({
      style: ranked[i].style,
      liters: release.workLiters || 2500,
      sizeLabel: brewSizeForTankNumber(source?.tankNumber, release.workLiters || 2500),
    });
  }
  return { recommendations, capacity: remainingCapacity, capacityBeforeCurrent };
}

export function buildWeeklyPlanningModel(args: {
  settings: Settings;
  pallets: Pallet[];
  tanks: Tank[];
  plans: WeekPlan[];
  actuals: Actual[];
  sources: Fermentor[];
  today: string;
  week: string;
  holidays: Holiday[];
  shipments: ShipmentEvent[];
}): WeeklyPlanningModel {
  const { settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments } = args;
  const weekEnd = addDays(week, 6);
  const normalized = forecastSettings(settings, today);
  const forecastPlans = dateWeeklyPackaging(plans);

  const stages: WeeklyStage[] = ["base", "afterShipment", "afterPackaging", "committed"];
  const forecasts = {} as Record<WeeklyStage, DailyResult>;
  const rows = {} as Record<WeeklyStage, Map<string, WeeklySkuState>>;

  for (const stage of stages) {
    forecasts[stage] = dailyForecast(
      normalized,
      pallets,
      tanks,
      plansAtStage(forecastPlans, week, stage),
      actuals,
      today,
      holidays,
      false,
      shipments,
    );
    rows[stage] = skuRows(normalized, forecasts[stage], weekEnd);
  }

  const shipment = buildShipmentRecommendation(normalized, rows.base);
  const packaging = buildPackagingRecommendation(
    normalized,
    rows.afterShipment,
    tanks,
    plans,
    actuals,
    week,
    weekEnd,
  );

  const brew = buildBrewRecommendation(
    normalized,
    rows.afterPackaging,
    tanks,
    forecastPlans,
    actuals,
    sources,
    today,
    week,
    weekEnd,
  );

  const coreProducts = normalized.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const tankAvailableLiters = new Map(
    tanks.map((tank) => [
      tank.id,
      remainingTankLiters(tank, plans, coreProducts, actuals, week),
    ] as const),
  );

  return {
    week,
    weekEnd,
    forecasts,
    rows,
    shipmentRecommendation: shipment.recommendation,
    shipmentSlots: shipment.slots,
    shipmentCanFillTruck: shipment.full,
    packagingRecommendation: packaging.recommendation,
    packagingDays: packaging.days,
    packagingCapacity: packaging.capacity,
    brewRecommendations: brew.recommendations,
    availableBrewTanks: brew.capacity,
    brewTankCapacity: brew.capacityBeforeCurrent,
    tankAvailableLiters,
  };
}
