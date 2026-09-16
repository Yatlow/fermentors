import type { Pallet } from "../cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  sameStyle,
  tempoNow,
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
import { brewSizeLabel, tankReleases, type BrewSizeLabel, type TankSource } from "./productionCycle";
import { displayStyle, isCoreStyle } from "./planningPresentation";
import { buildWeekStartProjection, type WeekStartProjection } from "./weekStartProjection";
import { planningTargetsForStyle } from "./planningTargets";

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
  sizeLabel: BrewSizeLabel;
  fifoRank: number;
  fifoTotal: number;
};

export type WeeklyBrewRecommendation = {
  style: string;
  liters: number;
  sizeLabel: BrewSizeLabel;
  tankId: string;
  tankNumber: string;
  availableDate: string;
};

export type WeeklyBrewTankOption = {
  tankId: string;
  tankNumber: string;
  availableDate: string;
  workLiters: number;
  sizeLabel: BrewSizeLabel;
};

export type WeeklyPlanningModel = {
  week: string;
  weekEnd: string;
  forecasts: Record<WeeklyStage, DailyResult>;
  rows: Record<WeeklyStage, Map<string, WeeklySkuState>>;
  /** Expected stock immediately before the selected week begins. */
  weekStartRows: Map<string, WeekStartProjection>;
  shipmentRecommendation: WeeklyShipmentRecommendation[];
  shipmentSlots: number;
  shipmentCanFillTruck: boolean;
  packagingRecommendation: WeeklyPackagingRecommendation[];
  packagingDays: number;
  packagingCapacity: number;
  brewRecommendations: WeeklyBrewRecommendation[];
  /** Tank choices available during this week before decisions saved in this week consume them. */
  brewTankOptions: WeeklyBrewTankOption[];
  /** Remaining tank positions after decisions already saved for the selected week. */
  availableBrewTanks: number;
  /** Tank capacity available at the start of the selected week, before that week's decisions. */
  brewTankCapacity: number;
  tankAvailableLiters: Map<string, number>;
};

function forecastSettings(settings: Settings, today: string): Settings {
  return {
    ...settings,
    products: settings.products.map((p) => {
      const projectedTempo = tempoNow(p, today);
      return {
        ...p,
        tempo: projectedTempo,
        tempoDate: projectedTempo === null ? p.tempoDate : today,
      };
    }),
  };
}

function dateWeeklyPackaging(plans: WeekPlan[], tanks: Tank[]): WeekPlan[] {
  return plans.map((week) => {
    const next = structuredClone(week);
    const dispatch = [...(next.deliveries ?? [])]
      .map((d) => d.dispatchDate)
      .filter((date) => date >= week.id && date <= addDays(week.id, 6))
      .sort()[0];
    const forecastDate = dispatch ?? addDays(week.id, 4);
    next.packaging = next.packaging.map((run) => {
      if (run.date) return run;
      const tankReady = run.tankId ? tanks.find((tank) => tank.id === run.tankId)?.ready : undefined;
      return { ...run, date: tankReady && tankReady > forecastDate ? tankReady : forecastDate };
    });
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
  const actualDays = new Set(
    actuals.map(actualDate).filter((d): d is string => !!d && d >= week && d <= weekEnd),
  );
  const capacity = Math.max(
    0,
    (plans.find((w) => w.id === week)?.maxRuns ?? settings.preferredRuns) - actualDays.size,
  );

  const eligibleTanks = tanks
    .filter((tank) => tank.ready <= weekEnd)
    .map((tank) => ({
      tank,
      liters: remainingTankLiters(tank, plans, products, actuals, week),
    }))
    .filter((entry) => entry.liters >= 20)
    .sort((a, b) => a.tank.brewed.localeCompare(b.tank.brewed) || Number(a.tank.number) - Number(b.tank.number));

  const remainingByTank = new Map(eligibleTanks.map(({ tank, liters }) => [tank.id, liters] as const));
  const virtualCover = new Map<string, number>();
  for (const p of products) virtualCover.set(p.id, rows.get(p.id)?.totalCover ?? Infinity);

  const fifoMeta = new Map<string, { rank: number; total: number }>();
  for (const tank of eligibleTanks.map((entry) => entry.tank)) {
    const peers = eligibleTanks
      .map((entry) => entry.tank)
      .filter((candidate) => sameStyle(candidate.style, tank.style));
    const rank = peers.findIndex((candidate) => candidate.id === tank.id) + 1;
    fifoMeta.set(tank.id, { rank, total: peers.length });
  }

  const daysNeeded = (items: WeeklyPackagingRecommendation[]) => {
    const crateRuns = items.filter((x) => products.find((p) => p.id === x.productId)?.type === "crates").length;
    const totalKegs = items.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.productId);
      return sum + (p?.type === "kegs" ? item.quantity : 0);
    }, 0);
    return crateRuns + (totalKegs > 0 ? Math.ceil(totalKegs / 150) : 0);
  };

  const selected: WeeklyPackagingRecommendation[] = [];

  const makeRun = (
    tank: Tank,
    originalLiters: number,
    p: Product,
    quantity: number,
    id: string,
  ): WeeklyPackagingRecommendation => {
    const fifo = fifoMeta.get(tank.id) ?? { rank: 1, total: 1 };
    return {
      id,
      productId: p.id,
      quantity,
      tankId: tank.id,
      tankNumber: String(tank.number),
      liters: originalLiters,
      dayCost: p.type === "crates" ? 1 : quantity / 150,
      sizeLabel: brewSizeLabel(originalLiters, tank.number),
      fifoRank: fifo.rank,
      fifoTotal: fifo.total,
    };
  };

  const drainingBundle = (
    tank: Tank,
    originalLiters: number,
    first: WeeklyPackagingRecommendation,
  ) => {
    const firstProduct = products.find((p) => p.id === first.productId)!;
    let residual = Math.max(0, (remainingByTank.get(tank.id) ?? 0) - first.quantity * litersPerUnit(firstProduct));
    const bundle: WeeklyPackagingRecommendation[] = [first];
    let part = 1;

    while (residual >= 20 && part <= 4) {
      const alternatives = products
        .filter((p) => sameStyle(p.style, tank.style))
        .sort((a, b) => Number(a.type === firstProduct.type) - Number(b.type === firstProduct.type));
      const drainProduct = alternatives[0];
      if (!drainProduct) break;
      const fullUnits = Math.floor((residual + 1e-8) / litersPerUnit(drainProduct));
      if (fullUnits <= 0) break;
      const quantity = drainProduct.type === "crates" ? Math.min(252, fullUnits) : fullUnits;
      if (quantity <= 0) break;
      bundle.push(makeRun(
        tank,
        originalLiters,
        drainProduct,
        quantity,
        `${first.id}:drain:${part}`,
      ));
      residual = Math.max(0, residual - quantity * litersPerUnit(drainProduct));
      part += 1;
    }

    return { bundle, residual };
  };

  while (true) {
    const candidates: Array<WeeklyPackagingRecommendation & { cover: number; brewed: string }> = [];

    for (const { tank, liters: originalLiters } of eligibleTanks) {
      const remainingLiters = remainingByTank.get(tank.id) ?? 0;
      if (remainingLiters < 20) continue;

      for (const p of products.filter((x) => sameStyle(x.style, tank.style))) {
        const cover = virtualCover.get(p.id) ?? Infinity;
        const targets = planningTargetsForStyle(settings, p.style);
        const demand = weeklyDemand(p);
        if (!Number.isFinite(cover) || demand <= 0 || cover >= targets.totalTargetWeeks) continue;

        const fullByTank = Math.floor((remainingLiters + 1e-8) / litersPerUnit(p));
        if (fullByTank <= 0) continue;

        let quantity: number;
        if (p.type === "crates") {
          // Coverage decides WHETHER to package. Once the machine is started,
          // operational batch size wins even when it crosses maxTotalWeeks.
          const size = brewSizeLabel(originalLiters, tank.number);
          quantity = size === "בודד"
            ? Math.min(252, fullByTank)
            : Math.min(168, fullByTank);
        } else {
          const maxByCoverage = Math.floor(Math.max(0, (targets.maxTotalWeeks - cover) * demand) + 1e-8);
          quantity = Math.min(fullByTank, maxByCoverage);
        }
        if (quantity <= 0) continue;

        candidates.push({
          ...makeRun(tank, originalLiters, p, quantity, `weekly-pack:${week}:${tank.id}:${p.id}`),
          cover,
          brewed: tank.brewed,
        });
      }
    }

    candidates.sort((a, b) =>
      a.cover - b.cover ||
      a.brewed.localeCompare(b.brewed) ||
      a.fifoRank - b.fifoRank ||
      a.tankNumber.localeCompare(b.tankNumber),
    );

    let picked: { bundle: WeeklyPackagingRecommendation[]; residual: number } | null = null;
    for (const candidate of candidates) {
      const tank = eligibleTanks.find((entry) => entry.tank.id === candidate.tankId)?.tank;
      const originalLiters = eligibleTanks.find((entry) => entry.tank.id === candidate.tankId)?.liters;
      if (!tank || originalLiters === undefined) continue;
      const attempt = drainingBundle(tank, originalLiters, candidate);
      if (attempt.residual >= 20) continue;
      if (daysNeeded([...selected, ...attempt.bundle]) <= capacity) {
        picked = attempt;
        break;
      }
    }
    if (!picked) break;

    selected.push(...picked.bundle);
    const tankId = picked.bundle[0].tankId;
    remainingByTank.set(tankId, picked.residual);
    for (const run of picked.bundle) {
      const p = products.find((x) => x.id === run.productId)!;
      const demand = weeklyDemand(p);
      if (demand > 0) virtualCover.set(p.id, (virtualCover.get(p.id) ?? 0) + run.quantity / demand);
    }
  }

  return { recommendation: selected, days: daysNeeded(selected), capacity };
}

function buildBrewRecommendation(
  settings: Settings,
  rows: Map<string, WeeklySkuState>,
  tanks: Tank[],
  plans: WeekPlan[],
  actuals: Actual[],
  sources: TankSource[],
  today: string,
  week: string,
  weekEnd: string,
) {
  const planningStart = weekStart(today);
  const currentWeek = plans.find((w) => w.id === week);

  const priorAssignedTankIds = new Set(
    plans
      .filter((w) => w.id >= planningStart && w.id < week)
      .flatMap((w) => w.brews)
      .filter((b) => !!b.tankId && b.date <= weekEnd)
      .map((b) => b.tankId),
  );

  const releases = tankReleases(sources, tanks, plans, settings, actuals, today)
    .filter((r) => !!r.date && r.date! <= weekEnd && !priorAssignedTankIds.has(r.tankId))
    .sort((a, b) =>
      (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31") ||
      Number(sources.find((s) => s.id === a.tankId)?.tankNumber ?? Infinity) -
        Number(sources.find((s) => s.id === b.tankId)?.tankNumber ?? Infinity),
    );

  const priorReservedTankIds = new Set<string>();
  const priorUnassignedBrews = plans
    .filter((w) => w.id >= planningStart && w.id < week)
    .flatMap((w) => w.brews)
    .filter((b) => !b.tankId && b.date <= weekEnd)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const brew of priorUnassignedBrews) {
    const release = releases.find((r) =>
      !priorReservedTankIds.has(r.tankId) && !!r.date && r.date <= brew.date,
    );
    if (release) priorReservedTankIds.add(release.tankId);
  }

  const capacityReleases = releases.filter((r) => !priorReservedTankIds.has(r.tankId));
  const currentReservedTankIds = new Set<string>();

  for (const brew of currentWeek?.brews.filter((b) => !!b.tankId && b.date <= weekEnd) ?? []) {
    if (capacityReleases.some((r) => r.tankId === brew.tankId)) {
      currentReservedTankIds.add(brew.tankId);
    }
  }

  const currentUnassigned = currentWeek?.brews.filter((b) => !b.tankId && b.date <= weekEnd) ?? [];
  for (let i = 0; i < currentUnassigned.length; i++) {
    const release = capacityReleases.find((r) =>
      !currentReservedTankIds.has(r.tankId) && !!r.date && r.date <= weekEnd,
    );
    if (release) currentReservedTankIds.add(release.tankId);
  }

  const availableReleases = capacityReleases.filter((r) => !currentReservedTankIds.has(r.tankId));
  const capacityBeforeCurrent = capacityReleases.length;
  const remainingCapacity = availableReleases.length;
  const tankOptions: WeeklyBrewTankOption[] = capacityReleases.map((release) => {
    const source = sources.find((s) => s.id === release.tankId);
    const tankNumber = String(source?.tankNumber ?? release.tankId);
    const workLiters = release.workLiters || 2500;
    return {
      tankId: release.tankId,
      tankNumber,
      availableDate: release.date!,
      workLiters,
      sizeLabel: brewSizeLabel(workLiters, source?.tankNumber),
    };
  });

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
    const tankNumber = String(source?.tankNumber ?? release.tankId);
    recommendations.push({
      style: ranked[i].style,
      liters: release.workLiters || 2500,
      sizeLabel: brewSizeLabel(release.workLiters || 2500, source?.tankNumber),
      tankId: release.tankId,
      tankNumber,
      availableDate: release.date!,
    });
  }
  return {
    recommendations,
    capacity: remainingCapacity,
    capacityBeforeCurrent,
    tankOptions,
  };
}

export function buildWeeklyPlanningModel(args: {
  settings: Settings;
  pallets: Pallet[];
  tanks: Tank[];
  plans: WeekPlan[];
  actuals: Actual[];
  sources: TankSource[];
  today: string;
  week: string;
  holidays: Holiday[];
  shipments: ShipmentEvent[];
}): WeeklyPlanningModel {
  const { settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments } = args;
  const weekEnd = addDays(week, 6);
  const normalized = forecastSettings(settings, today);
  const forecastPlans = dateWeeklyPackaging(plans, tanks);

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

  const weekStartRows = buildWeekStartProjection({ settings, pallets, plans, actuals, today, week });
  const shipment = buildShipmentRecommendation(normalized, weekStartRows);
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
    weekStartRows,
    shipmentRecommendation: shipment.recommendation,
    shipmentSlots: shipment.slots,
    shipmentCanFillTruck: shipment.full,
    packagingRecommendation: packaging.recommendation,
    packagingDays: packaging.days,
    packagingCapacity: packaging.capacity,
    brewRecommendations: brew.recommendations,
    brewTankOptions: brew.tankOptions,
    availableBrewTanks: brew.capacity,
    brewTankCapacity: brew.capacityBeforeCurrent,
    tankAvailableLiters,
  };
}
