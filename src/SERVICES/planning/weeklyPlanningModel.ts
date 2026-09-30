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
  type Plan,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import {
  actualDate,
  dailyForecast,
  futureTanks,
  openRuns,
  type DailyResult,
  type ShipmentEvent,
} from "./dailyPlanner";
import { buildShipmentRecommendation } from "./shipmentRecommendation";
import { brewSizeLabel, tankReleases, type BrewSizeLabel, type TankSource } from "./productionCycle";
import { displayStyle, isCoreStyle } from "./planningPresentation";
import { buildWeekStartProjection, type WeekStartProjection } from "./weekStartProjection";
import { projectTankSchedules } from "./tankScheduleProjection";
import { tankCanHostCycle } from "./tankSchedule";
import { planningTargetsForStyle } from "./planningTargets";
import { resolvePackagingBrewId } from "./planIdentity";

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
  brewId?: string;
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
  weekStartRows: Map<string, WeekStartProjection>;
  shipmentRecommendation: WeeklyShipmentRecommendation[];
  shipmentSlots: number;
  shipmentCanFillTruck: boolean;
  packagingRecommendation: WeeklyPackagingRecommendation[];
  packagingDays: number;
  packagingCapacity: number;
  brewRecommendations: WeeklyBrewRecommendation[];
  brewTankOptions: WeeklyBrewTankOption[];
  availableBrewTanks: number;
  brewTankCapacity: number;
  tankAvailableLiters: Map<string, number>;
};

function forecastSettings(settings: Settings, today: string): Settings {
  return {
    ...settings,
    products: settings.products.map((p) => {
      const projectedTempo = tempoNow(p, today);
      return { ...p, tempo: projectedTempo, tempoDate: projectedTempo === null ? p.tempoDate : today };
    }),
  };
}

function dateWeeklyPackaging(plans: WeekPlan[], tanks: Tank[]): WeekPlan[] {
  const plannedBrews = plans.flatMap((week) => week.brews ?? []);
  const readyForRun = (run: Plan) => {
    if (run.brewId) {
      const brew = plannedBrews.find((item) => item.id === run.brewId);
      if (brew) return tanks.find((tank) =>
        tank.id === brew.tankId &&
        tank.brewed === brew.date &&
        sameStyle(tank.style, brew.style)
      )?.ready;
    }
    return run.tankId ? tanks.find((tank) => tank.id === run.tankId)?.ready : undefined;
  };
  return plans.map((week) => {
    const next = structuredClone(week);
    const dispatch = [...(next.deliveries ?? [])]
      .map((d) => d.dispatchDate)
      .filter((date) => date >= week.id && date <= addDays(week.id, 6))
      .sort()[0];
    const forecastDate = dispatch ?? addDays(week.id, 4);
    next.packaging = next.packaging.map((run) => {
      if (run.date) return run;
      const tankReady = readyForRun(run);
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
  return result.points.filter((p) => p.productId === productId && p.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0];
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

function plannedBrewId(tank: Tank) {
  return tank.id.startsWith("planned:") ? tank.id.slice("planned:".length) : "";
}

function cycleKey(tank: Tank) {
  const brewId = plannedBrewId(tank);
  return brewId ? `brew:${brewId}` : `physical:${tank.id}`;
}

function remainingTankLiters(
  tank: Tank,
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  selectedWeek: string,
) {
  let liters = tank.liters;
  const brewId = plannedBrewId(tank);
  const priorPlans = plans.map((w) => w.id === selectedWeek ? { ...w, packaging: [] } : w);
  for (const run of openRuns(priorPlans, products, actuals)) {
    if (run.remaining <= 0 || run.week >= selectedWeek) continue;
    const belongs = brewId
      ? resolvePackagingBrewId(run, plans) === brewId
      : !!run.tankId && run.tankId === tank.id && !resolvePackagingBrewId(run, plans);
    if (!belongs) continue;
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
  sources: TankSource[],
  week: string,
  weekEnd: string,
) {
  const products = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const actualDays = new Set(actuals.map(actualDate).filter((d): d is string => !!d && d >= week && d <= weekEnd));
  const capacity = Math.max(0, (plans.find((w) => w.id === week)?.maxRuns ?? settings.preferredRuns) - actualDays.size);

  // Include both the physical cycle that exists now and every committed future
  // brew cycle. The synthetic planned:* id is only an internal cycle key; saved
  // packaging is written against the physical tankId plus stable brewId.
  const projectedTanks = futureTanks(tanks, plans, settings);
  const eligibleTanks = projectedTanks
    .filter((tank) => tank.ready <= weekEnd)
    .map((tank) => ({ tank, liters: remainingTankLiters(tank, plans, products, actuals, week) }))
    .filter((entry) => entry.liters >= 20)
    .sort((a, b) => a.tank.brewed.localeCompare(b.tank.brewed) || Number(a.tank.number) - Number(b.tank.number));

  const remainingByCycle = new Map(eligibleTanks.map(({ tank, liters }) => [cycleKey(tank), liters] as const));
  const virtualCover = new Map<string, number>();
  for (const p of products) virtualCover.set(p.id, rows.get(p.id)?.totalCover ?? Infinity);

  const fifoMeta = new Map<string, { rank: number; total: number }>();
  for (const tank of eligibleTanks.map((entry) => entry.tank)) {
    const peers = eligibleTanks.map((entry) => entry.tank).filter((candidate) => sameStyle(candidate.style, tank.style));
    const rank = peers.findIndex((candidate) => cycleKey(candidate) === cycleKey(tank)) + 1;
    fifoMeta.set(cycleKey(tank), { rank, total: peers.length });
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

  const makeRun = (tank: Tank, originalLiters: number, p: Product, quantity: number, id: string): WeeklyPackagingRecommendation => {
    const brewId = plannedBrewId(tank);
    const brew = brewId ? plans.flatMap((plan) => plan.brews).find((item) => item.id === brewId) : undefined;
    const physicalTankId = brew?.tankId ?? tank.id;
    const source = sources.find((item) => item.id === physicalTankId);
    const tankNumber = String(source?.tankNumber ?? (brew ? physicalTankId : tank.number));
    const fifo = fifoMeta.get(cycleKey(tank)) ?? { rank: 1, total: 1 };
    return {
      id,
      productId: p.id,
      quantity,
      tankId: physicalTankId,
      tankNumber,
      ...(brewId ? { brewId } : {}),
      liters: originalLiters,
      dayCost: p.type === "crates" ? 1 : quantity / 150,
      sizeLabel: brewSizeLabel(originalLiters, source?.tankNumber ?? tank.number),
      fifoRank: fifo.rank,
      fifoTotal: fifo.total,
    };
  };

  const drainingBundle = (tank: Tank, originalLiters: number, first: WeeklyPackagingRecommendation) => {
    const firstProduct = products.find((p) => p.id === first.productId)!;
    const key = cycleKey(tank);
    let residual = Math.max(0, (remainingByCycle.get(key) ?? 0) - first.quantity * litersPerUnit(firstProduct));
    const bundle: WeeklyPackagingRecommendation[] = [first];
    let part = 1;
    while (residual >= 20 && part <= 4) {
      const alternatives = products.filter((p) => sameStyle(p.style, tank.style)).sort((a, b) => Number(a.type === firstProduct.type) - Number(b.type === firstProduct.type));
      const drainProduct = alternatives[0];
      if (!drainProduct) break;
      const fullUnits = Math.floor((residual + 1e-8) / litersPerUnit(drainProduct));
      if (fullUnits <= 0) break;
      const quantity = drainProduct.type === "crates" ? Math.min(252, fullUnits) : fullUnits;
      if (quantity <= 0) break;
      bundle.push(makeRun(tank, originalLiters, drainProduct, quantity, `${first.id}:drain:${part}`));
      residual = Math.max(0, residual - quantity * litersPerUnit(drainProduct));
      part += 1;
    }
    return { bundle, residual };
  };

  while (true) {
    const candidates: Array<WeeklyPackagingRecommendation & { cover: number; brewed: string; cycle: string }> = [];
    for (const { tank, liters: originalLiters } of eligibleTanks) {
      const key = cycleKey(tank);
      const remainingLiters = remainingByCycle.get(key) ?? 0;
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
          const maxByCoverage = Math.floor(Math.max(0, (targets.maxTotalWeeks - cover) * demand) + 1e-8);
          quantity = Math.min(252, fullByTank, maxByCoverage);
        } else {
          const maxByCoverage = Math.floor(Math.max(0, (targets.maxTotalWeeks - cover) * demand) + 1e-8);
          quantity = Math.min(fullByTank, maxByCoverage);
        }
        if (quantity <= 0) continue;
        candidates.push({
          ...makeRun(tank, originalLiters, p, quantity, `weekly-pack:${week}:${key}:${p.id}`),
          cover,
          brewed: tank.brewed,
          cycle: key,
        });
      }
    }

    candidates.sort((a, b) => a.cover - b.cover || a.brewed.localeCompare(b.brewed) || a.fifoRank - b.fifoRank || a.tankNumber.localeCompare(b.tankNumber));
    let picked: { bundle: WeeklyPackagingRecommendation[]; residual: number; cycle: string } | null = null;
    for (const candidate of candidates) {
      const entry = eligibleTanks.find(({ tank }) => cycleKey(tank) === candidate.cycle);
      if (!entry) continue;
      const attempt = drainingBundle(entry.tank, entry.liters, candidate);
      if (attempt.residual >= 20) continue;
      if (daysNeeded([...selected, ...attempt.bundle]) <= capacity) {
        picked = { ...attempt, cycle: candidate.cycle };
        break;
      }
    }
    if (!picked) break;
    selected.push(...picked.bundle);
    remainingByCycle.set(picked.cycle, picked.residual);
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
  const releases = tankReleases(sources, tanks, plans, settings, actuals, today)
    .filter((r) => !!r.date && r.date! <= weekEnd)
    .sort((a, b) => (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31") || Number(sources.find((s) => s.id === a.tankId)?.tankNumber ?? Infinity) - Number(sources.find((s) => s.id === b.tankId)?.tankNumber ?? Infinity));

  const priorReservedTankIds = new Set<string>();
  const priorUnassignedBrews = plans.filter((w) => w.id >= planningStart && w.id < week).flatMap((w) => w.brews).filter((b) => !b.tankId && b.date <= weekEnd).sort((a, b) => a.date.localeCompare(b.date));
  for (const brew of priorUnassignedBrews) {
    const release = releases.find((r) => !priorReservedTankIds.has(r.tankId) && !!r.date && r.date <= brew.date);
    if (release) priorReservedTankIds.add(release.tankId);
  }

  const capacityReleases = releases.filter((r) => !priorReservedTankIds.has(r.tankId));
  const currentReservedTankIds = new Set<string>();
  for (const brew of currentWeek?.brews.filter((b) => !!b.tankId && b.date <= weekEnd) ?? []) {
    if (capacityReleases.some((r) => r.tankId === brew.tankId)) currentReservedTankIds.add(brew.tankId);
  }
  const currentUnassigned = currentWeek?.brews.filter((b) => !b.tankId && b.date <= weekEnd) ?? [];
  for (let i = 0; i < currentUnassigned.length; i++) {
    const release = capacityReleases.find((r) => !currentReservedTankIds.has(r.tankId) && !!r.date && r.date <= weekEnd);
    if (release) currentReservedTankIds.add(release.tankId);
  }

  const availableReleases = capacityReleases.filter((r) => !currentReservedTankIds.has(r.tankId));
  const capacityBeforeCurrent = capacityReleases.length;
  const schedules = projectTankSchedules(plans, settings);
  const releaseFitsCanonicalWindow = (release: (typeof capacityReleases)[number], style?: string) => {
    const candidateDate = release.date && release.date > week ? release.date : week;
    if (candidateDate > weekEnd) return false;
    const cycles = schedules.get(release.tankId) ?? [];
    if (!style) {
      // Generic capacity is intentionally conservative: if another canonical
      // cycle starts after this date we cannot claim the slot without knowing
      // whether the proposed beer will be ready in time.
      return tankCanHostCycle(cycles, candidateDate, "9999-12-31");
    }
    const leadDays = Math.max(
      ...settings.products.filter((p) => sameStyle(p.style, style)).map((p) => p.leadDays),
      21,
    );
    return tankCanHostCycle(cycles, candidateDate, addDays(candidateDate, leadDays));
  };
  const canonicalAvailableReleases = availableReleases.filter((release) => releaseFitsCanonicalWindow(release));
  const remainingCapacity = canonicalAvailableReleases.length;
  const tankOptions: WeeklyBrewTankOption[] = canonicalAvailableReleases.map((release) => {
    const source = sources.find((s) => s.id === release.tankId);
    const tankNumber = String(source?.tankNumber ?? release.tankId);
    const workLiters = release.workLiters || 2500;
    return { tankId: release.tankId, tankNumber, availableDate: release.date!, workLiters, sizeLabel: brewSizeLabel(workLiters, source?.tankNumber) };
  });

  const styles = [...new Set(settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style)).map((p) => displayStyle(p.style)))];
  const styleStates = styles.map((style) => {
    const productRows = [...rows.values()].filter((r) => sameStyle(r.product.style, style));
    const demandLiters = productRows.reduce((sum, r) => sum + weeklyDemand(r.product) * litersPerUnit(r.product), 0);
    const stockLiters = productRows.reduce((sum, r) => {
      const units = (r.tempoUnits ?? 0) + r.breweryUnits;
      return sum + units * litersPerUnit(r.product);
    }, 0);
    const cover = demandLiters > 0 ? stockLiters / demandLiters : Infinity;
    return { style, demandLiters, stockLiters, cover, targets: planningTargetsForStyle(settings, style) };
  }).filter((state) => state.demandLiters > 0);

  const recommendations: WeeklyBrewRecommendation[] = [];
  const remainingReleases = [...canonicalAvailableReleases];
  const remainingStyles = [...styleStates];
  while (recommendations.length < remainingCapacity && remainingReleases.length && remainingStyles.length) {
    let best: { styleIndex: number; releaseIndex: number; score: number } | null = null;
    for (let si = 0; si < remainingStyles.length; si++) {
      const state = remainingStyles[si];
      for (let ri = 0; ri < remainingReleases.length; ri++) {
        const release = remainingReleases[ri];
        // Tank availability and recommendation generation must use the same
        // canonical cycle-window rule. A tank shown as available must actually
        // be able to host this style before its next committed cycle.
        if (!releaseFitsCanonicalWindow(release, state.style)) continue;
        const liters = release.workLiters || 2500;
        const postCover = (state.stockLiters + liters) / state.demandLiters;
        // Prefer filling the target without overshooting it. Large tanks are
        // naturally penalized for slow-moving styles because they create many
        // more weeks of cover; fast-moving styles can absorb them cheaply.
        const targetGap = Math.max(0, state.targets.targetWeeks - postCover);
        const overTarget = Math.max(0, postCover - state.targets.targetWeeks);
        const overMax = Math.max(0, postCover - state.targets.maxTotalWeeks);
        const urgency = Math.max(0, state.targets.targetWeeks - state.cover);
        const score = targetGap * 100 + overMax * 1000 + overTarget * 10 - urgency;
        if (!best || score < best.score) best = { styleIndex: si, releaseIndex: ri, score };
      }
    }
    if (!best) break;
    const state = remainingStyles.splice(best.styleIndex, 1)[0];
    const release = remainingReleases.splice(best.releaseIndex, 1)[0];
    const source = sources.find((s) => s.id === release.tankId);
    const tankNumber = String(source?.tankNumber ?? release.tankId);
    const liters = release.workLiters || 2500;
    recommendations.push({ style: state.style, liters, sizeLabel: brewSizeLabel(liters, source?.tankNumber), tankId: release.tankId, tankNumber, availableDate: release.date! });
  }
  return { recommendations, capacity: remainingCapacity, capacityBeforeCurrent, tankOptions };
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
    forecasts[stage] = dailyForecast(normalized, pallets, tanks, plansAtStage(forecastPlans, week, stage), actuals, today, holidays, false, shipments);
    rows[stage] = skuRows(normalized, forecasts[stage], weekEnd);
  }

  const weekStartRows = buildWeekStartProjection({ settings, pallets, plans, actuals, today, week });
  const shipment = buildShipmentRecommendation(normalized, weekStartRows);
  const packaging = buildPackagingRecommendation(normalized, rows.afterShipment, tanks, plans, actuals, sources, week, weekEnd);
  const brew = buildBrewRecommendation(normalized, rows.afterPackaging, tanks, forecastPlans, actuals, sources, today, week, weekEnd);
  // Automatic packaging stays core-range only. Manual packaging, however,
  // must expose every real/planned beer cycle (including seasonal styles).
  const packagingTankPool = futureTanks(tanks, plans, settings);
  const allPackagingProducts = normalized.products.filter((p) => p.monthly > 0);
  const tankAvailableLiters = new Map(
    packagingTankPool.map((tank) => [tank.id, remainingTankLiters(tank, plans, allPackagingProducts, actuals, week)] as const),
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