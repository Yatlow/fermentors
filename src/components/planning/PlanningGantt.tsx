import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { withTentativeFiveWeekTanks } from "../../SERVICES/planning/tentativePackaging";
import { CalendarDays, SquarePen } from "lucide-react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  inventory,
  parseDate,
  sameStyle,
  tempoNow,
  weeklyDemand,
  weekNumber,
  weekStart,
  type Actual,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { actualDate, actualUnits, matchesActual, openRuns, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle, weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import { matchActualShipments } from "../../SERVICES/planning/shipmentActuals";
import { plansAfterActualPackagingCompletion } from "../../SERVICES/planning/packagingActuals";
import { buildWeeklyPlanningModel, type WeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import PlanningFiveWeekOverview from "./PlanningFiveWeekOverview";
import PlanningGanttWeekEditorModal from "./PlanningGanttWeekEditorModal";
import PlanningGanttDailyModal from "./PlanningGanttDailyModal";
import BeerLoader from "../general/Loading";

const CRATE_LITERS = 24 * 0.33;
const KEG_LITERS = 20;
const ROWS = [
  { id: "stock", label: "מלאי וכיסוי" },
  { id: "deliveries", label: "משלוחים" },
  { id: "packaging", label: "אריזות" },
  { id: "brews", label: "בישולים" },
] as const;
const STYLE_ORDER = ["IPA", "פייל", "חיטה", "לאגר", "הופי לאגר", "סטאוט"] as const;

type RowId = (typeof ROWS)[number]["id"];
type EditorKind = Exclude<RowId, "stock">;
type EditorTarget = { week: string; kind: EditorKind };
type GanttMode = "summary" | "calendar";
type SummaryItem = {
  key: string;
  title: string;
  meta: string;
  styleClass?: string;
  recommended?: boolean;
  stockKind?: "actual" | "projected" | "history";
  actual?: boolean;
  stockLines?: Array<{ style: string; values: string[] }>;
};

type SimulatedWeek = {
  model: WeeklyPlanningModel;
  effectivePlan: WeekPlan;
  deliveryRecommendation: WeeklyPlanningModel["shipmentRecommendation"];
  packagingRecommendation: WeeklyPlanningModel["packagingRecommendation"];
  brewRecommendation: WeeklyPlanningModel["brewRecommendations"];
};

type Props = {
  settings: Settings;
  plans: WeekPlan[];
  editorPlans: WeekPlan[];
  historyPlans: WeekPlan[];
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  holidays: Holiday[];
  today: string;
  disabled: boolean;
  canEdit: boolean;
  saveWeek: (week: WeekPlan, options?: { allowClosedWeek?: boolean }) => Promise<void>;
  moveCalendarEvent: (
    sourceWeekId: string,
    targetWeekId: string,
    eventId: string,
    nextEvent: { id: string; title: string; startDate: string; endDate: string; type: "general"; note?: string },
  ) => Promise<void>;
  onOpenCoolerMap?: () => void;
};

const fmt = (value: number) => Math.round(value).toLocaleString("he-IL");
const cover = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} שב׳`;
const packageLiters = (quantity: number, type: "crates" | "kegs") => quantity * (type === "crates" ? CRATE_LITERS : KEG_LITERS);
const tankLabel = (value?: string | number | null) => value === undefined || value === null || String(value).trim() === ""
  ? "טרם שובץ למיכל"
  : `מיכל ${value}`;
const styleRank = (style: string) => {
  const rank = STYLE_ORDER.findIndex((candidate) => sameStyle(candidate, style));
  return rank < 0 ? STYLE_ORDER.length : rank;
};
const sortedStyleEntries = <T,>(map: Map<string, T>) =>
  [...map.entries()].sort(([a], [b]) => styleRank(a) - styleRank(b) || a.localeCompare(b, "he"));

export default function PlanningGantt(props: Props) {
  const {
    settings,
    editorPlans,
    historyPlans,
    tanks,
    sources,
    pallets,
    actuals,
    shipments,
    holidays,
    today,
    canEdit,
  } = props;
  const [mode, setMode] = useState<GanttMode>("summary");
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [dailyTarget, setDailyTarget] = useState<EditorTarget | null>(null);
  const [isOpeningEditor, setIsOpeningEditor] = useState(false);
  const openEditor = (target: EditorTarget, daily = false) => {
    setIsOpeningEditor(true);
    window.setTimeout(() => {
      if (daily) setDailyTarget(target);
      else setEditorTarget(target);
      window.setTimeout(() => setIsOpeningEditor(false), 0);
    }, 0);
  };
  const [weekPage, setWeekPage] = useState(0);
  const [isPaging, startPaginationTransition] = useTransition();
  const changeWeekPage = (next: number | ((current: number) => number)) => {
    startPaginationTransition(() => setWeekPage(next));
  };
  const currentWeek = weekStart(today);
  const nextPlanningWeek = addDays(currentWeek, 7);
  const planningHorizonWeeks = canEdit ? 13 : 4;
  const allWeekIds = useMemo(
    () => Array.from({ length: planningHorizonWeeks + 1 }, (_, index) => addDays(currentWeek, (index - 1) * 7)),
    [currentWeek],
  );
  const maxWeekPage = Math.max(0, Math.ceil((allWeekIds.length - 5) / 4));
  const weekIds = useMemo(() => {
    const start = Math.min(weekPage * 4, Math.max(0, allWeekIds.length - 5));
    return allWeekIds.slice(start, start + 5);
  }, [allWeekIds, weekPage]);
  const visibleRows = canEdit ? ROWS : ROWS.filter((row) => row.id !== "stock");
  const oldestInventoryUpdate = useMemo(() => settings.products
    .filter((product) => product.monthly > 0 && product.tempo !== null)
    .map((product) => parseDate(product.tempoDate))
    .filter((date): date is string => !!date)
    .sort()[0], [settings.products]);
  const actualStockLabel = oldestInventoryUpdate ? `מעודכן ל־${shortDate(oldestInventoryUpdate)}` : "בפועל";
  const planByWeek = useMemo(() => new Map(historyPlans.map((plan) => [plan.id, plan])), [historyPlans]);
  const actualsByWeek = useMemo(() => {
    const grouped = new Map<string, Actual[]>();
    for (const actual of actuals) {
      const date = actualDate(actual);
      if (!date) continue;
      const week = weekStart(date);
      grouped.set(week, [...(grouped.get(week) ?? []), actual]);
    }
    return grouped;
  }, [actuals]);

  const [simulations, setSimulations] = useState<Map<string, SimulatedWeek>>(() => new Map());
  const [isSimulating, setIsSimulating] = useState(true);
  const [pendingSimulationWeeks, setPendingSimulationWeeks] = useState<Set<string>>(() => new Set());
  const simulationGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const generation = ++simulationGeneration.current;
    setIsSimulating(true);
    setPendingSimulationWeeks(new Set(weekIds));

    const run = async () => {
    const result = new Map<string, SimulatedWeek>();
    let effectivePlans = historyPlans.map((plan) => structuredClone(plan));

    const upsertPlan = (plan: WeekPlan) => {
      const index = effectivePlans.findIndex((candidate) => candidate.id === plan.id);
      if (index >= 0) effectivePlans[index] = structuredClone(plan);
      else effectivePlans = [...effectivePlans, structuredClone(plan)];
    };

    const buildModel = (week: string) => buildWeeklyPlanningModel({
      settings,
      pallets,
      tanks,
      plans: effectivePlans,
      actuals,
      sources,
      today,
      week,
      holidays,
      shipments,
    });

    for (const week of weekIds) {
      if (cancelled || generation !== simulationGeneration.current) return;
      await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
      const saved = planByWeek.get(week);
      let workingPlan: WeekPlan = saved
        ? structuredClone(saved)
        : { ...emptyWeek(week), maxRuns: settings.preferredRuns };
      upsertPlan(workingPlan);

      let model = buildModel(week);
      await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
      let deliveryRecommendation: WeeklyPlanningModel["shipmentRecommendation"] = [];
      let packagingRecommendation: WeeklyPlanningModel["packagingRecommendation"] = [];
      let brewRecommendation: WeeklyPlanningModel["brewRecommendations"] = [];

      if (week >= currentWeek) {
        const hasDeliveryDecision = (saved?.deliveries ?? []).some((item) => item.quantity > 0);
        if (!hasDeliveryDecision) {
          deliveryRecommendation = model.shipmentRecommendation.filter((item) => item.quantity > 0);
          if (deliveryRecommendation.length) {
            const date = addDays(week, 1);
            workingPlan = {
              ...workingPlan,
              deliveries: deliveryRecommendation.map((item) => ({
                id: `gantt-rec-delivery:${week}:${item.productId}`,
                productId: item.productId,
                quantity: item.quantity,
                dispatchDate: date,
                arrivalDate: date,
                truckId: `gantt-rec-truck:${week}`,
                pallets: [],
              })),
              deliveryDates: [date],
            };
            upsertPlan(workingPlan);
            model = buildModel(week);
            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
          }
        }

        const hasPackagingDecision = (saved?.packaging ?? []).some((item) => item.quantity > 0);
        if (!hasPackagingDecision) {
          packagingRecommendation = model.packagingRecommendation.filter((item) => item.quantity > 0);
          if (packagingRecommendation.length) {
            workingPlan = {
              ...workingPlan,
              packaging: packagingRecommendation.map((item, index, all) => ({
                id: item.id,
                productId: item.productId,
                quantity: item.quantity,
                tankId: item.tankId,
                tankNumber: item.tankNumber,
                ...(item.brewId ? { brewId: item.brewId } : {}),
                source: "recommendation" as const,
                emptyTank: !all.slice(index + 1).some((later) => later.tankId === item.tankId),
              })),
            };
            upsertPlan(workingPlan);
            model = buildModel(week);
            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
          }
        }

        const hasBrewDecision = (saved?.brews ?? []).some((item) => item.liters > 0);
        if (!hasBrewDecision) {
          brewRecommendation = model.brewRecommendations.filter((item) => item.liters > 0);
          if (brewRecommendation.length) {
            workingPlan = {
              ...workingPlan,
              brews: brewRecommendation.map((item, index) => ({
                id: `gantt-rec-brew:${week}:${index}`,
                style: item.style,
                liters: item.liters,
                tankId: "",
                date: addDays(week, 1),
              })),
            };
            upsertPlan(workingPlan);
            model = buildModel(week);
            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
          }
        }
      }

      result.set(week, {
        model,
        effectivePlan: workingPlan,
        deliveryRecommendation,
        packagingRecommendation,
        brewRecommendation,
      });
      if (cancelled || generation !== simulationGeneration.current) return;
      const completed = result.get(week);
      if (completed) {
        setSimulations((previous) => {
          const next = new Map(previous);
          next.set(week, completed);
          return next;
        });
      }
      setPendingSimulationWeeks((previous) => {
        const next = new Set(previous);
        next.delete(week);
        return next;
      });
    }

      if (cancelled || generation !== simulationGeneration.current) return;
      setPendingSimulationWeeks(new Set());
      setIsSimulating(false);
    };

    // Let the loader/previous UI paint before starting planning CPU work.
    const timer = window.setTimeout(() => { void run(); }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settings, pallets, tanks, historyPlans, planByWeek, actuals, sources, today, weekIds, holidays, shipments, currentWeek]);

  const productFor = (id: string) => settings.products.find((product) => product.id === id);
  const decisionPlanFor = (weekId: string) => planByWeek.get(weekId);

  function assignedBrewTankNumber(item: WeekPlan["brews"][number]) {
    if (!item.tankId) return undefined;
    return tanks.find((tank) => tank.id === item.tankId)?.number
      ?? sources.find((source) => source.id === item.tankId)?.tankNumber
      ?? sources.find((source) => String(source.tankNumber) === String(item.tankId))?.tankNumber;
  }

  const calendarPlans = useMemo(() => weekIds.flatMap((weekId) => {
    const plan = simulations.get(weekId)?.effectivePlan;
    if (!plan) return [];
    return [{
      ...plan,
      brews: plan.brews
        .filter((brew) => !!brew.tankId)
        .map((brew) => ({
          ...brew,
          tankNumber: assignedBrewTankNumber(brew),
        })),
    }];
  }), [simulations, weekIds, tanks, sources]);

  const calendarTanks = useMemo(() => {
    const aliases = [...tanks];
    for (const plan of calendarPlans) {
      for (const brew of plan.brews) {
        if (!brew.tankId || aliases.some((tank) => tank.id === brew.tankId)) continue;
        const number = assignedBrewTankNumber(brew);
        if (number === undefined || number === null || String(number).trim() === "") continue;
        aliases.push({
          id: brew.tankId,
          number,
          style: brew.style,
          liters: 0,
          ready: "9999-12-31",
          brewed: "9999-12-31",
        } as Tank);
      }
    }
    return aliases;
  }, [calendarPlans, tanks, sources]);

  function compactShipmentItems(weekId: string): SummaryItem[] {
    const plan = decisionPlanFor(weekId);
    const decisions = (plan?.deliveries ?? []).filter((item) => item.quantity > 0);
    const recommended = decisions.length === 0 && weekId >= currentWeek;
    const recommendations = simulations.get(weekId)?.deliveryRecommendation ?? [];

    if (!decisions.length) {
      if (!recommendations.length) return [];
      const grouped = new Map<string, string[]>();
      for (const item of recommendations) {
        const product = productFor(item.productId);
        if (!product) continue;
        const style = displayStyle(product.style);
        const line = `${product.type === "crates" ? "בקבוקים" : "חביות"} ${fmt(item.quantity)}`;
        grouped.set(style, [...(grouped.get(style) ?? []), line]);
      }
      const stockLines = sortedStyleEntries(grouped).map(([style, values]) => ({ style, values }));
      return [{
        key: `delivery-summary:${weekId}:recommended`,
        title: "משלוח טמפו",
        meta: stockLines.map(({ style, values }) => `${style} · ${values.join(" · ")}`).join("\n"),
        stockLines,
        recommended,
      }];
    }

    // A legacy week may contain many historical delivery rows from repeated edits.
    // Render operational trips, not every persisted row. Once a trip has an actual
    // shipment, use the actual manifest as the single source for its summary.
    const matches = matchActualShipments(decisions, shipments, settings.products);
    return matches.map((match, index) => {
      const grouped = new Map<string, string[]>();
      if (match.status !== "pending" && match.actual?.totals?.length) {
        for (const actual of match.actual.totals) {
          const style = displayStyle(actual.beerStyle);
          const line = `${actual.itemType === "crates" ? "בקבוקים" : "חביות"} ${fmt(actual.totalQuantity)}`;
          grouped.set(style, [...(grouped.get(style) ?? []), line]);
        }
      } else {
        const byProduct = new Map<string, number>();
        for (const delivery of match.planned.deliveries) {
          byProduct.set(delivery.productId, (byProduct.get(delivery.productId) ?? 0) + delivery.quantity);
        }
        for (const [productId, quantity] of byProduct) {
          const product = productFor(productId);
          if (!product) continue;
          const style = displayStyle(product.style);
          const line = `${product.type === "crates" ? "בקבוקים" : "חביות"} ${fmt(quantity)}`;
          grouped.set(style, [...(grouped.get(style) ?? []), line]);
        }
      }
      const stockLines = sortedStyleEntries(grouped).map(([style, values]) => ({ style, values }));
      const shipmentNumber = match.actual?.shipmentNumber ?? index + 1;
      const suffix = matches.length > 1 ? ` ${shipmentNumber}` : "";
      return {
        key: `delivery-summary:${weekId}:${match.planned.id}`,
        title: `משלוח טמפו${suffix}`,
        meta: stockLines.map(({ style, values }) => `${style} · ${values.join(" · ")}`).join("\n"),
        stockLines,
        actual: match.status !== "pending",
      };
    }).filter((item) => item.stockLines.length > 0);
  }

  function packagingItems(weekId: string): SummaryItem[] {
    const rawDecisionPlan = decisionPlanFor(weekId) ?? emptyWeek(weekId);
    const completionAwarePlan = plansAfterActualPackagingCompletion(
      [rawDecisionPlan], settings.products, actuals, sources,
    )[0];
    const decisions = (completionAwarePlan?.packaging ?? []).filter((item) => item.quantity > 0);
    const actualItems: SummaryItem[] = (actualsByWeek.get(weekId) ?? [])
      .filter((actual) => Number(actual.quantity) > 0)
      .map((actual) => {
        const product = settings.products.find((candidate) => matchesActual(candidate, actual));
        const quantity = product ? actualUnits(product, actual) : Number(actual.quantity) || 0;
        const type = product?.type ?? (actual.packagingType === "kegs" ? "kegs" : "crates");
        const tankNumber = actual.tankNumber;
        const style = product?.style ?? actual.beerStyle ?? "";
        return {
          key: `pack-actual:${actual.id}`,
          title: `${displayStyle(style)} · ${tankLabel(tankNumber)}`,
          meta: `${fmt(quantity)} ${type === "crates" ? "ארגזים" : "חביות"} · ${fmt(packageLiters(quantity, type))} ל׳ · בוצע בפועל`,
          styleClass: style ? beerStyleClass(style).className : undefined,
          actual: true,
        };
      });

    // A completed operational report replaces the matching planning card in
    // the summary. Keep unmatched/partially open planning rows visible, but do
    // not render the same tank/package cycle twice as "actual" + "planned".
    const openByKey = new Map(
      openRuns([completionAwarePlan ?? rawDecisionPlan], settings.products, actuals)
        .map((run) => [run.id ?? run.key, run.remaining] as const),
    );
    const plannedItems: SummaryItem[] = decisions.flatMap((item, index) => {
      const remaining = openByKey.get(item.id ?? `${weekId}:${item.productId}:${index}`) ?? item.quantity;
      if (remaining <= 0) return [];
      const product = productFor(item.productId);
      const tank = tanks.find((candidate) => candidate.id === item.tankId);
      // Canonical tankId (aligned from brewId/cycle) wins over the historical
      // tankNumber snapshot. The snapshot is only a legacy/display fallback.
      const resolvedTank = tank?.number ?? item.tankNumber;
      const style = product?.style ?? item.nonInventoryStyle ?? "";
      const type = product?.type ?? item.nonInventoryType;
      return [{
        key: `pack:${item.id ?? index}`,
        title: style ? `${displayStyle(style)} · ${tankLabel(resolvedTank)}` : item.productId,
        meta: type
          ? `${fmt(remaining)} ${type === "crates" ? "ארגזים" : "חביות"} · ${fmt(packageLiters(remaining, type))} ל׳ · מתוכנן`
          : fmt(remaining),
        styleClass: style ? beerStyleClass(style).className : undefined,
      }];
    });

    const recommendationItems: SummaryItem[] = decisions.length || weekId < currentWeek
      ? []
      : (simulations.get(weekId)?.packagingRecommendation ?? []).map((item) => {
          const product = productFor(item.productId);
          return {
            key: `pack-rec:${item.id}`,
            title: `${product ? displayStyle(product.style) : item.productId} · ${tankLabel(item.tankNumber)}`,
            meta: `${fmt(item.quantity)} ${product?.type === "crates" ? "ארגזים" : "חביות"} · ${fmt(item.quantity * (product ? (product.type === "crates" ? CRATE_LITERS : KEG_LITERS) : 1))} ל׳`,
            styleClass: product ? beerStyleClass(product.style).className : undefined,
            recommended: true,
          };
        });

    return [...actualItems, ...plannedItems, ...recommendationItems];
  }

  function brewItems(weekId: string): SummaryItem[] {
    const actualBrews: SummaryItem[] = sources
      .flatMap((source) => {
        const brewDate = parseDate(source.brewDate ?? "");
        if (!brewDate || weekStart(brewDate) !== weekId || brewDate >= today) return [];
        const style = source.beerStyle ?? "";
        const liters = Math.max(0, Number(source.beerVolume) || 0);
        return [{
          key: `brew-actual:${source.id}:${String(source.batchNumber ?? "")}:${brewDate}`,
          title: `${displayStyle(style)} · ${tankLabel(source.tankNumber)}`,
          meta: `${liters > 0 ? `${fmt(liters)} ל׳ · ` : ""}${shortDate(brewDate)} · בוצע בפועל`,
          styleClass: style ? beerStyleClass(style).className : undefined,
          actual: true,
        }];
      });

    const decisions = (decisionPlanFor(weekId)?.brews ?? [])
      .filter((item) => item.liters > 0 && item.date >= today);
    const plannedBrews: SummaryItem[] = decisions.map((item) => ({
      key: `brew:${item.id}`,
      title: `${displayStyle(item.style)} · ${tankLabel(assignedBrewTankNumber(item))}`,
      meta: `${fmt(item.liters)} ל׳ · ${shortDate(item.date)} · מתוכנן`,
      styleClass: beerStyleClass(item.style).className,
    }));

    const recommendationBrews: SummaryItem[] = decisions.length || weekId < currentWeek
      ? []
      : (simulations.get(weekId)?.brewRecommendation ?? []).map((item, index) => ({
          key: `brew-rec:${weekId}:${item.style}:${index}`,
          title: `${displayStyle(item.style)} · ${tankLabel(item.tankNumber)}`,
          meta: `${item.sizeLabel} · ${fmt(item.liters)} ל׳ · זמין ${shortDate(item.availableDate)}`,
          styleClass: beerStyleClass(item.style).className,
          recommended: true,
        }));

    return [...actualBrews, ...plannedBrews, ...recommendationBrews];
  }

  function stockItems(weekId: string): SummaryItem[] {
    if (weekId < currentWeek) {
      return [{ key: `stock-history:${weekId}`, title: "אין snapshot היסטורי", meta: "הסנאפשוט נשמר מעכשיו והלאה", stockKind: "history" }];
    }

    const grouped = new Map<string, string[]>();
    if (weekId === currentWeek) {
      for (const product of settings.products.filter((item) => item.monthly > 0)) {
        const inv = inventory(product, pallets);
        const brewery = inv.brewery + inv.dock;
        const tempo = tempoNow(product, today);
        const demand = weeklyDemand(product);
        const total = brewery + (tempo ?? 0);
        const totalCover = tempo === null || demand <= 0 ? null : total / demand;
        const line = `${product.type === "crates" ? "בקבוקים" : "חביות"} ${fmt(total)} (${cover(totalCover)})`;
        const style = displayStyle(product.style);
        grouped.set(style, [...(grouped.get(style) ?? []), line]);
      }
    } else {
      for (const row of simulations.get(weekId)?.model.weekStartRows.values() ?? []) {
        if (row.product.monthly <= 0) continue;
        const total = row.breweryUnits + (row.tempoUnits ?? 0);
        const line = `${row.product.type === "crates" ? "בקבוקים" : "חביות"} ${fmt(total)} (${cover(row.totalCover)})`;
        const style = displayStyle(row.product.style);
        grouped.set(style, [...(grouped.get(style) ?? []), line]);
      }
    }

    const stockLines = sortedStyleEntries(grouped).map(([style, values]) => ({ style, values }));
    const lines = stockLines.map(({ style, values }) => `${style} · ${values.join(" · ")}`);
    return lines.length ? [{
      key: `stock-summary:${weekId}`,
      title: weekId === currentWeek ? "מלאי נוכחי" : "פתיחת שבוע",
      meta: lines.join("\n"),
      stockLines,
      stockKind: weekId === currentWeek ? "actual" : "projected",
    }] : [];
  }

  function itemsFor(row: RowId, weekId: string) {
    if (row === "deliveries") return compactShipmentItems(weekId);
    if (row === "packaging") return packagingItems(weekId);
    if (row === "brews") return brewItems(weekId);
    return stockItems(weekId);
  }

  function weeklyTotals(weekId: string) {
    const plan = simulations.get(weekId)?.effectivePlan ?? decisionPlanFor(weekId);
    const plannedPackaging = (plan?.packaging ?? []).reduce((sum, run) => {
      const product = productFor(run.productId);
      const type = product?.type ?? run.nonInventoryType;
      return sum + (type && run.quantity > 0 ? packageLiters(run.quantity, type) : 0);
    }, 0);
    const actualPackaging = actuals.reduce((sum, actual) => {
      const date = actualDate(actual);
      if (!date || weekStart(date) !== weekId || Number(actual.quantity) <= 0) return sum;
      const product = settings.products.find((candidate) => matchesActual(candidate, actual));
      const quantity = product ? actualUnits(product, actual) : Number(actual.quantity) || 0;
      const type = product?.type ?? (actual.packagingType === "kegs" ? "kegs" : "crates");
      return sum + packageLiters(quantity, type);
    }, 0);
    const actualBrewing = sources.reduce((sum, source) => {
      const brewDate = parseDate(source.brewDate ?? "");
      if (!brewDate || weekStart(brewDate) !== weekId || brewDate >= today) return sum;
      return sum + Math.max(0, Number(source.beerVolume) || 0);
    }, 0);
    const plannedBrewing = (plan?.brews ?? [])
      .filter((brew) => brew.date >= today)
      .reduce((sum, brew) => sum + Math.max(0, Number(brew.liters) || 0), 0);
    return {
      packaging: actualPackaging + plannedPackaging,
      brewing: actualBrewing + plannedBrewing,
    };
  }

  function dailyPendingCount(kind: EditorKind, weekId: string) {
    const plan = decisionPlanFor(weekId);
    if (!plan) return 0;
    if (kind === "deliveries") return 0;
    if (kind === "packaging") {
      return plan.packaging.filter((run) => run.quantity > 0 && !run.date).length;
    }
    return plan.brews.filter((brew) => brew.liters > 0 && !brew.tankId).length;
  }

  const editor = editorTarget && canEdit ? (
    <PlanningGanttWeekEditorModal
      week={editorTarget.week}
      kind={editorTarget.kind}
      onClose={() => setEditorTarget(null)}
      settings={settings}
      plans={editorPlans}
      historyPlans={historyPlans}
      tanks={tanks}
      sources={sources}
      pallets={pallets}
      actuals={actuals}
      shipments={shipments}
      holidays={holidays}
      today={today}
      disabled={props.disabled}
      saveWeek={props.saveWeek}
      onOpenCoolerMap={props.onOpenCoolerMap}
    />
  ) : null;

  const dailyEditorPlans = useMemo(
    () => dailyTarget ? withTentativeFiveWeekTanks(editorPlans, tanks, settings).map((plan) => ({
      ...plan,
      brews: plan.brews.map((brew) => {
        const tentativeTankId = (brew as typeof brew & { tentativeTankId?: string }).tentativeTankId;
        return !brew.tankId && tentativeTankId
          ? { ...brew, tankId: tentativeTankId, tankAssignmentStatus: "tentative" as const }
          : brew;
      }),
    })) : editorPlans,
    [dailyTarget, editorPlans, tanks, settings],
  );

  const dailyEditor = dailyTarget && canEdit ? (
    <PlanningGanttDailyModal
      week={dailyTarget.week}
      kind={dailyTarget.kind}
      onClose={() => setDailyTarget(null)}
      settings={settings}
      plans={dailyEditorPlans}
      tanks={tanks}
      sources={sources}
      pallets={pallets}
      actuals={actuals}
      shipments={shipments}
      holidays={holidays}
      today={today}
      disabled={props.disabled}
      saveWeek={(week) => props.saveWeek(week)}
    />
  ) : null;

  if (mode === "calendar") {
    return <>
      <section className="bp-gantt-shell">
        {(isPaging || isSimulating) && <BeerLoader overlay message={isPaging ? "טוען שבוע…" : "טוען המלצות שבועיות…"} />}
        {isOpeningEditor && <BeerLoader overlay message="פותח…" />}
        <div className="bp-section-heading bp-gantt-heading">
          <div><h2>לוח שנה</h2><p className="bp-muted">{canEdit ? "חלון של 5 שבועות מתוך אופק תכנון של 13 שבועות קדימה." : "מבט 5 שבועות."}</p></div>
          <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
            <button type="button" aria-pressed={false} onClick={() => setMode("summary")}>סיכום שבועי</button>
            <button type="button" aria-pressed={true}>לוח שנה</button>
          </div>
        </div>
        <div className="bp-gantt-horizon-nav" role="group" aria-label="ניווט בין שבועות התכנון">
          {canEdit && <button type="button" disabled={weekPage === 0} onClick={() => changeWeekPage((page) => Math.max(0, page - 1))}>‹ מוקדם יותר</button>}
          <span>{shortDate(weekIds[0])}–{shortDate(addDays(weekIds[weekIds.length - 1], 6))}</span>
          {canEdit && <button type="button" disabled={weekPage >= maxWeekPage} onClick={() => changeWeekPage((page) => Math.min(maxWeekPage, page + 1))}>מאוחר יותר ›</button>}
        </div>
        <div className="bp-gantt-calendar-host">
          <PlanningFiveWeekOverview {...props} plans={calendarPlans} tanks={calendarTanks} visibleWeekIds={weekIds} />
        </div>
      </section>
      {editor}
      {dailyEditor}
    </>;
  }

  return <>
    <section className="bp-gantt-shell">
      {isOpeningEditor && <BeerLoader overlay message="פותח…" />}
      <div className="bp-section-heading bp-gantt-heading">
        <div><h2>גאנט</h2><p className="bp-muted">{canEdit ? "חלון של 5 שבועות מתוך אופק תכנון של 13 שבועות קדימה." : "מבט 5 שבועות."}</p></div>
        <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
          <button type="button" aria-pressed={true}>סיכום שבועי</button>
          <button type="button" aria-pressed={false} onClick={() => setMode("calendar")}>לוח שנה</button>
        </div>
      </div>

        <div className="bp-gantt-horizon-nav" role="group" aria-label="ניווט בין שבועות התכנון">
          {canEdit && <button type="button" disabled={weekPage === 0} onClick={() => changeWeekPage((page) => Math.max(0, page - 1))}>‹ מוקדם יותר</button>}
          <span>{shortDate(weekIds[0])}–{shortDate(addDays(weekIds[weekIds.length - 1], 6))}</span>
          {canEdit && <button type="button" disabled={weekPage >= maxWeekPage} onClick={() => changeWeekPage((page) => Math.min(maxWeekPage, page + 1))}>מאוחר יותר ›</button>}
        </div>

      <div className="bp-gantt-legend" aria-label="מקרא">
        {canEdit && <>
          <span className="is-actual">● מלאי נוכחי / בפועל</span>
          <span className="is-projected">◌ צפי לפתיחת שבוע</span>
        </>}
        <span className="is-recommendation">המלצה — מחושבת קדימה כאילו התקבלה</span>
      </div>

      <div className="bp-five-week-scroll">
        <div className="bp-five-week-grid bp-gantt-grid" role="table" aria-label="גאנט תכנון לחמישה שבועות">
          <div className="bp-five-week-corner" />
          {weekIds.map((weekId) => {
            const totals = weeklyTotals(weekId);
            const weekHolidays = holidays.filter((holiday) => holiday.date >= weekId && holiday.date <= addDays(weekId, 6));
            return (
              <div key={`head:${weekId}`} className={`bp-five-week-head ${weekId === currentWeek ? "is-current" : ""} ${weekId === nextPlanningWeek ? "is-next" : ""}`}>
                <b>שבוע {weekNumber(weekId)}</b>
                <span>{shortDate(weekId)}–{shortDate(addDays(weekId, 6))}</span>
                {(totals.packaging > 0 || totals.brewing > 0) && <small>אריזה {fmt(totals.packaging)} ל׳ · בישול {fmt(totals.brewing)} ל׳</small>}
                {weekHolidays.length > 0 && <div className="bp-gantt-holidays" aria-label="אירועי השבוע">{weekHolidays.slice(0, 3).map((holiday) => <span className="bp-gantt-holiday-chip" key={`${holiday.date}:${holiday.title}`}><b>{shortDate(holiday.date)}</b><span>{holiday.title}</span></span>)}{weekHolidays.length > 3 && <span className="bp-gantt-holiday-more" title={weekHolidays.slice(3).map((holiday) => `${shortDate(holiday.date)} · ${holiday.title}`).join("\n")}>+{weekHolidays.length - 3} אירועים</span>}</div>}
                {weekId === currentWeek && <small>השבוע</small>}
                {weekId === nextPlanningWeek && <small>שבוע התכנון הבא</small>}
              </div>
            );
          })}

          {visibleRows.map((row) => (
            <Fragment key={row.id}>
              <div className={`bp-five-week-row-label is-${row.id}`}>{row.label}</div>
              {weekIds.map((weekId) => {
                const weekPending = pendingSimulationWeeks.has(weekId);
                const items = itemsFor(row.id, weekId);
                const editableKind = row.id === "stock" ? null : row.id;
                const canEditWeek = canEdit && editableKind && !weekIsClosed(weekId, today);
                const plan = decisionPlanFor(weekId);
                const hasDecision = editableKind === "packaging"
                  ? (plan?.packaging ?? []).some((item) => item.quantity > 0)
                  : editableKind === "brews"
                    ? (plan?.brews ?? []).some((item) => item.liters > 0)
                    : false;
                const pendingCount = editableKind ? dailyPendingCount(editableKind, weekId) : 0;
                return (
                  <div className={`bp-five-week-cell is-${row.id}`} key={`${row.id}:${weekId}`}>
                    {canEditWeek && (
                      <div className="bp-gantt-cell-actions">
                        <button
                          type="button"
                          className="bp-gantt-cell-edit"
                          aria-label={`עריכת ${row.label} בשבוע ${weekNumber(weekId)}`}
                          title={`עריכת ${row.label}`}
                          onClick={() => openEditor({ week: weekId, kind: editableKind })}
                        >
                          <SquarePen size={15} aria-hidden="true" />
                        </button>
                        {editableKind !== "deliveries" && hasDecision && (
                          <button
                            type="button"
                            className="bp-gantt-cell-edit bp-gantt-cell-calendar"
                            aria-label={`תכנון יומי של ${row.label} בשבוע ${weekNumber(weekId)}${pendingCount ? `, ${pendingCount} ממתינים לשיבוץ` : ""}`}
                            title={editableKind === "brews" ? "סדר ושיבוץ בישולים" : `תכנון יומי · ${row.label}`}
                            onClick={() => openEditor({ week: weekId, kind: editableKind }, true)}
                          >
                            <CalendarDays size={15} aria-hidden="true" />
                            {pendingCount > 0 && <span className="bp-gantt-action-badge">{pendingCount}</span>}
                          </button>
                        )}
                      </div>
                    )}
                    {items.map((item) => (
                      <article
                        className={`bp-five-week-item ${item.styleClass ?? ""} ${item.recommended ? "is-gantt-recommendation" : ""} ${item.stockKind ? `is-stock-${item.stockKind}` : ""} ${item.actual ? "is-gantt-actual" : ""}`}
                        key={item.key}
                      >
                        <b>{item.title}</b>
                        {item.stockLines ? (
                          <small className="bp-gantt-stock-lines">
                            {item.stockLines.map((line) => (
                              <span key={line.style}><strong>{line.style}</strong> · {line.values.join(" · ")}</span>
                            ))}
                          </small>
                        ) : <small>{item.meta}</small>}
                        {item.recommended && <span className="bp-gantt-rec-label">המלצה · טרם נקבע</span>}
                        {item.stockKind === "actual" && <span className="bp-gantt-stock-label">{actualStockLabel}</span>}
                        {item.stockKind === "projected" && <span className="bp-gantt-stock-label">צפי לפתיחת השבוע</span>}
                      </article>
                    ))}
                    {weekPending && <div className="bp-gantt-cell-loader"><BeerLoader size="spinner" message="" /></div>}
                    {!items.length && !weekPending && <span className="bp-five-week-empty">—</span>}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
    {editor}
    {dailyEditor}
  </>;
}
