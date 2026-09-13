import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  sameStyle,
  weeklyDemand,
  weekNumber,
  weekStart,
  type Actual,
  type DeliveryPlan,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import {
  actualDate,
  openRuns,
  shortDate,
  type ShipmentEvent,
} from "../../SERVICES/planning/dailyPlanner";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { tankReleases, weekday } from "../../SERVICES/planning/productionCycle";
import {
  CORE_STYLES,
  displayStyle,
  isCoreStyle,
  recommendationSettings,
} from "../../SERVICES/planning/planningPresentation";
import {
  adoptAction,
  planningWorkspace,
  type PlanningAction,
} from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
type DeliveryAction = PlanningAction & {
  kind: "delivery";
  productId: string;
  quantity: number;
  pallets?: Pallet[];
  slots?: number;
  truckId?: string;
};
type PackagingAction = PlanningAction & {
  kind: "packaging";
  productId: string;
  quantity: number;
  allocations: { tankId: string; number: string; liters: number; ready: string; cold: boolean }[];
  reason?: string;
};
type BrewAction = PlanningAction & {
  kind: "brew";
  style: string;
  tankId: string;
  liters: number;
  reason: string;
};
type Kind = PlanningAction["kind"];
type BrewDraft = { style: string; liters: number };
type GapSeverity = "none" | "warning" | "critical";

const fmt = (n: number) => Math.round(n).toLocaleString("he-IL", { maximumFractionDigits: 0 });
const palletSize = (p: { type: "crates" | "kegs" }) => (p.type === "crates" ? 84 : 20);
const plannerDefaultWeek = (today: string) =>
  weekday(today) >= 5 ? addDays(weekStart(today), 7) : weekStart(today);

function decisionGap(
  recommended: number,
  decided: number,
  afterCover: number | null,
  targetCover: number,
): GapSeverity {
  // A different decision is not a problem by itself. If the resulting cover is
  // already at/above target, there is no operational gap to warn about.
  if (afterCover !== null && afterCover >= targetCover) return "none";
  if (recommended <= 0 || decided >= recommended) return "none";
  const shortfall = (recommended - decided) / recommended;
  if (decided === 0 || shortfall >= 0.5) return "critical";
  if (shortfall >= 0.2) return "warning";
  return "none";
}

export default function PlanningWeeklyRecommendations({
  settings,
  plans,
  tanks,
  sources,
  pallets,
  actuals,
  shipments,
  holidays,
  today,
  workspace,
  disabled,
  saveWeek,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  holidays: Holiday[];
  today: string;
  workspace: Workspace;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(() => plannerDefaultWeek(today));
  const [editing, setEditing] = useState<Kind | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});
  const [brewDraft, setBrewDraft] = useState<Record<string, BrewDraft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? {
    ...emptyWeek(week),
    maxRuns: settings.preferredRuns,
  };
  const weekEnd = addDays(week, 6);
  const product = (id: string) => settings.products.find((p) => p.id === id);
  const coreProducts = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const weekHolidays = holidays.filter((h) => h.date >= week && h.date <= weekEnd);

  // Shipment recommendation: remove this week's own decisions so the planner can
  // always compare the saved decision with a stable independent recommendation.
  const shipmentBaselineWorkspace = useMemo(() => {
    const baselinePlans = plans.map((w) =>
      w.id === week
        ? {
            ...structuredClone(w),
            packaging: [],
            brews: [],
            deliveries: [],
            deliveryDates: [],
            dismissedRecommendations: [],
          }
        : w,
    );
    return planningWorkspace(
      recommendationSettings(settings),
      pallets,
      tanks,
      baselinePlans,
      actuals,
      sources,
      today,
      holidays,
      shipments,
    );
  }, [plans, week, settings, pallets, tanks, actuals, sources, today, holidays, shipments]);

  // Production recommendation: preserve the shipment decision for this week, but
  // remove packaging/brew decisions. A shipment therefore CAN increase the amount
  // we recommend producing, while an unaccepted packaging recommendation cannot.
  const productionBaselineWorkspace = useMemo(() => {
    const baselinePlans = plans.map((w) =>
      w.id === week
        ? {
            ...structuredClone(w),
            packaging: [],
            brews: [],
            dismissedRecommendations: [],
          }
        : w,
    );
    return planningWorkspace(
      recommendationSettings(settings),
      pallets,
      tanks,
      baselinePlans,
      actuals,
      sources,
      today,
      holidays,
      shipments,
    );
  }, [plans, week, settings, pallets, tanks, actuals, sources, today, holidays, shipments]);

  const shipmentActions = useMemo(
    () => shipmentBaselineWorkspace.actions.filter((a) => weekStart(a.date) === week),
    [shipmentBaselineWorkspace.actions, week],
  );
  const productionActions = useMemo(
    () => productionBaselineWorkspace.actions.filter((a) => weekStart(a.date) === week),
    [productionBaselineWorkspace.actions, week],
  );
  const ship = shipmentActions.filter((a) => a.kind === "delivery") as DeliveryAction[];
  const enginePack = productionActions.filter((a) => a.kind === "packaging") as PackagingAction[];
  const engineBrew = productionActions.filter((a) => a.kind === "brew") as BrewAction[];

  const pointAt = (ws: Workspace, productId: string) =>
    ws.committedForecast.points
      .filter((p) => p.productId === productId && p.date <= weekEnd)
      .sort((a, b) => b.date.localeCompare(a.date))[0];

  const tempoCoverAt = (ws: Workspace, productId: string) => {
    const p = product(productId);
    const point = pointAt(ws, productId);
    if (!p || !point || weeklyDemand(p) <= 0 || point.tempo === null) return null;
    return point.tempo / weeklyDemand(p);
  };
  const totalCoverAt = (ws: Workspace, productId: string) => {
    const p = product(productId);
    const point = pointAt(ws, productId);
    if (!p || !point || weeklyDemand(p) <= 0 || point.tempo === null) return null;
    return (point.tempo + point.brewery) / weeklyDemand(p);
  };
  const shipmentBaselineCover = (id: string) => tempoCoverAt(shipmentBaselineWorkspace, id);
  const shipmentDecidedCover = (id: string) => tempoCoverAt(workspace, id);
  const productionBaselineCover = (id: string) => totalCoverAt(productionBaselineWorkspace, id);
  const productionDecidedCover = (id: string) => totalCoverAt(workspace, id);

  // An already planned-but-not-yet-executed run from an earlier week must reduce
  // the usable liters in that tank. Completed actuals are already subtracted by
  // tanksFrom(), so openRuns prevents both double-counting and resurrecting an
  // already emptied tank in a later week's recommendation.
  const openBeforeWeek = useMemo(
    () => openRuns(plans, settings.products, actuals).filter((r) => r.week < week && r.remaining > 0),
    [plans, settings.products, actuals, week],
  );
  const committedRemainingLiters = (tank: Tank) => {
    const reserved = openBeforeWeek
      .filter((r) => r.tankId === tank.id)
      .reduce((sum, r) => {
        const p = product(r.productId);
        return sum + (p ? r.remaining * litersPerUnit(p) : 0);
      }, 0);
    return Math.max(0, tank.liters - reserved);
  };

  const availableReleases = useMemo(() => {
    const pool = tankReleases(sources, tanks, plans, settings, actuals, today)
      .filter((r) => !!r.date && r.date! <= weekEnd)
      .sort((a, b) => a.date!.localeCompare(b.date!));
    const priorBrews = plans
      .filter((w) => w.id < week)
      .flatMap((w) => w.brews)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const b of priorBrews) {
      let index = b.tankId
        ? pool.findIndex((r) => r.tankId === b.tankId && r.date! <= b.date)
        : -1;
      if (index < 0) index = pool.findIndex((r) => r.date! <= b.date);
      if (index >= 0) pool.splice(index, 1);
    }
    return pool;
  }, [sources, tanks, plans, settings, actuals, today, week, weekEnd]);
  const availableTankCount = availableReleases.length;

  const maxPackagingRuns = Math.min(current.maxRuns, settings.preferredRuns);
  const occupiedPackagingDays = new Set([
    ...current.packaging.filter((r) => r.quantity > 0 && r.date).map((r) => r.date!),
    ...actuals.map(actualDate).filter((d): d is string => !!d && weekStart(d) === week),
  ]);
  const undatedCrateRuns = current.packaging.filter((r) => {
    const p = product(r.productId);
    return r.quantity > 0 && !r.date && p?.type === "crates";
  }).length;
  const undatedKegsByStyle = new Map<string, number>();
  for (const r of current.packaging.filter((r) => r.quantity > 0 && !r.date)) {
    const p = product(r.productId);
    if (p?.type !== "kegs") continue;
    const style = displayStyle(p.style);
    undatedKegsByStyle.set(style, (undatedKegsByStyle.get(style) ?? 0) + r.quantity);
  }
  const undatedKegRuns = [...undatedKegsByStyle.values()].reduce(
    (sum, qty) => sum + Math.ceil(qty / 150),
    0,
  );
  const usedPackagingRuns = occupiedPackagingDays.size + undatedCrateRuns + undatedKegRuns;
  const remainingPackagingRuns = Math.max(0, maxPackagingRuns - usedPackagingRuns);

  const warnings = useMemo(
    () =>
      workspace.needs
        .filter((n) => weekStart(n.date) === week)
        .map((n) => {
          const scheduled =
            n.kind === "packaging"
              ? current.packaging
                  .filter((p) => p.productId === n.productId)
                  .reduce((sum, p) => sum + p.quantity, 0)
              : current.brews
                  .filter((b) => sameStyle(b.style, n.style))
                  .reduce((sum, b) => sum + b.liters, 0);
          const explanation = n.problem.includes("כבר מוקצה")
            ? "הכמות שכבר נקבעה אינה סוגרת את הפער שחושב."
            : n.problem;
          return `${displayStyle(n.style)}: נקבע ${fmt(scheduled)} ${
            n.kind === "brew" ? "ל׳" : n.unit
          }; עדיין חסרים כ־${fmt(n.quantity)} ${n.unit}. ${explanation}`;
        })
        .slice(0, 6),
    [workspace.needs, week, current.packaging, current.brews],
  );

  const availableFor = (id: string) => {
    const p = product(id);
    if (!p)
      return { physicalPallets: 0, physicalQty: 0, plannedPallets: 0, plannedQty: 0 };
    const physical = pallets.filter(
      (x) => x.zone !== "shipped" && x.itemType === p.type && sameStyle(x.beerStyle, p.style),
    );
    const plannedQty = plans
      .filter((w) => w.id <= week)
      .flatMap((w) => w.packaging.map((x) => ({ ...x, weekId: w.id })))
      .filter((x) => x.productId === p.id && (x.date ?? x.weekId) <= weekEnd)
      .reduce((sum, x) => sum + x.quantity, 0);
    return {
      physicalPallets: physical.length,
      physicalQty: physical.reduce((sum, x) => sum + x.quantity, 0),
      plannedPallets: plannedQty ? projectedPallets(p, plannedQty, `week:${week}`).length : 0,
      plannedQty,
    };
  };

  const slotsFor = (p: (typeof coreProducts)[number], quantity: number) => {
    try {
      const manifest = projectedPallets(p, quantity, `slots:${week}:${p.id}`).map((x) => x.pallet);
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch {
      return 0;
    }
  };

  const shipmentRows = coreProducts.map((p) => {
    const recommendedQty = ship.filter((a) => a.productId === p.id).reduce((s, a) => s + a.quantity, 0);
    const decidedQty = (current.deliveries ?? []).filter((d) => d.productId === p.id).reduce((s, d) => s + d.quantity, 0);
    const recPallets = recommendedQty ? projectedPallets(p, recommendedQty, `rec:${week}:${p.id}`).length : 0;
    const decidedPallets = decidedQty ? Math.ceil(decidedQty / palletSize(p)) : 0;
    const before = shipmentBaselineCover(p.id);
    const after = shipmentDecidedCover(p.id);
    const gap = decisionGap(recPallets, decidedPallets, after, settings.targetWeeks);
    return {
      p,
      recommendedQty,
      decidedQty,
      recPallets,
      recSlots: slotsFor(p, recommendedQty),
      decidedPallets,
      availability: availableFor(p.id),
      before,
      after,
      gap,
      severity:
        after === null
          ? "neutral"
          : after < 1
            ? "critical"
            : after < settings.targetWeeks
              ? "warning"
              : "ok",
    };
  });

  const pack = useMemo(() => {
    const target = settings.totalTargetWeeks ?? settings.targetWeeks;
    type Candidate = PackagingAction & { cover: number; type: "crates" | "kegs"; style: string };
    const candidateMap = new Map<string, Candidate>();

    const addCandidate = (
      p: (typeof coreProducts)[number],
      tank: Tank,
      cover: number,
      source?: PackagingAction,
    ) => {
      const usableLiters = committedRemainingLiters(tank);
      if (cover >= target || tank.ready > weekEnd || usableLiters < 20) return;
      const quantity = Math.floor((usableLiters + 1e-8) / litersPerUnit(p));
      if (quantity <= 0) return;
      const key = `${tank.id}:${p.id}`;
      candidateMap.set(key, {
        id: source?.id ?? `weekly-pack:${week}:${p.id}:${tank.id}`,
        kind: "packaging",
        status: "recommended",
        date: tank.ready < week ? week : tank.ready,
        productId: p.id,
        quantity,
        allocations: [
          {
            tankId: tank.id,
            number: String(tank.number),
            liters: usableLiters,
            ready: tank.ready,
            cold: tank.cold,
          },
        ],
        reason: `כיסוי כולל צפוי ${cover.toFixed(1)} שבועות; מומלץ לרוקן את מיכל ${tank.number}`,
        cover,
        type: p.type,
        style: displayStyle(p.style),
      });
    };

    for (const a of enginePack) {
      const p = product(a.productId);
      const tankId = a.allocations[0]?.tankId;
      const tank = tanks.find((t) => t.id === tankId);
      const cover = p ? productionBaselineCover(p.id) : null;
      if (p && tank && cover !== null) addCandidate(p, tank, cover, a);
    }
    for (const tank of tanks) {
      if (tank.ready > weekEnd || committedRemainingLiters(tank) < 20) continue;
      for (const p of coreProducts.filter((p) => sameStyle(p.style, tank.style))) {
        const cover = productionBaselineCover(p.id);
        if (cover !== null) addCandidate(p, tank, cover);
      }
    }

    const selected: Candidate[] = [];
    const usedTankIds = new Set<string>();
    const virtualCover = new Map<string, number>(
      coreProducts.map((p) => [p.id, productionBaselineCover(p.id) ?? Infinity]),
    );

    const daysNeeded = (items: Candidate[]) => {
      const crateDays = items.filter((x) => x.type === "crates").length;
      const kegByStyle = new Map<string, number>();
      for (const item of items.filter((x) => x.type === "kegs"))
        kegByStyle.set(item.style, (kegByStyle.get(item.style) ?? 0) + item.quantity);
      const kegDays = [...kegByStyle.values()].reduce((sum, qty) => sum + Math.ceil(qty / 150), 0);
      return crateDays + kegDays;
    };

    while (selected.length < 20) {
      const choices = [...candidateMap.values()]
        .filter((c) => !usedTankIds.has(c.allocations[0].tankId))
        .filter((c) => (virtualCover.get(c.productId) ?? Infinity) < target)
        .sort(
          (a, b) =>
            (virtualCover.get(a.productId) ?? Infinity) -
            (virtualCover.get(b.productId) ?? Infinity),
        );
      const next = choices.find((c) => daysNeeded([...selected, c]) <= maxPackagingRuns);
      if (!next) break;
      selected.push(next);
      usedTankIds.add(next.allocations[0].tankId);
      const p = product(next.productId);
      if (p && weeklyDemand(p) > 0)
        virtualCover.set(p.id, (virtualCover.get(p.id) ?? 0) + next.quantity / weeklyDemand(p));
    }
    return selected;
  }, [
    enginePack,
    coreProducts,
    tanks,
    week,
    weekEnd,
    settings,
    productionBaselineWorkspace.committedForecast,
    openBeforeWeek,
  ]);

  const recommendedPackagingDays = useMemo(() => {
    const crateDays = pack.filter((a) => product(a.productId)?.type === "crates").length;
    const kegByStyle = new Map<string, number>();
    for (const a of pack) {
      const p = product(a.productId);
      if (p?.type !== "kegs") continue;
      const style = displayStyle(p.style);
      kegByStyle.set(style, (kegByStyle.get(style) ?? 0) + a.quantity);
    }
    return crateDays + [...kegByStyle.values()].reduce((sum, qty) => sum + Math.ceil(qty / 150), 0);
  }, [pack]);

  const packagingRows = coreProducts
    .map((p) => {
      const rec = pack.filter((a) => a.productId === p.id);
      const saved = current.packaging.filter((x) => x.productId === p.id);
      const recommendedQty = rec.reduce((s, a) => s + a.quantity, 0);
      const decidedQty = saved.reduce((s, a) => s + a.quantity, 0);
      const before = productionBaselineCover(p.id);
      const after = productionDecidedCover(p.id);
      const target = settings.totalTargetWeeks ?? settings.targetWeeks;
      return {
        p,
        rec,
        saved,
        before,
        after,
        recommendedQty,
        decidedQty,
        gap: decisionGap(recommendedQty, decidedQty, after, target),
        tankText: [
          ...new Set(
            [
              ...saved.map((x) => tanks.find((t) => t.id === x.tankId)?.number ?? x.tankNumber),
              ...rec.flatMap((x) => x.allocations.map((a) => a.number)),
            ].filter(Boolean),
          ),
        ].join(", "),
        severity:
          after === null
            ? "neutral"
            : after < 1
              ? "critical"
              : after < target
                ? "warning"
                : "ok",
      };
    })
    .sort((a, b) => (a.before ?? Infinity) - (b.before ?? Infinity));

  const brew = useMemo(() => {
    const result: BrewAction[] = [...engineBrew];
    const remainingSlots = Math.max(0, availableTankCount - current.brews.length);
    if (result.length >= remainingSlots) return result.slice(0, remainingSlots);
    const usedStyles = new Set([
      ...current.brews.map((b) => displayStyle(b.style)),
      ...result.map((b) => displayStyle(b.style)),
    ]);
    const styleRows = CORE_STYLES.map((style) => {
      const ps = coreProducts.filter((p) => sameStyle(p.style, style));
      const covers = ps
        .map((p) => productionBaselineCover(p.id))
        .filter((v): v is number => v !== null);
      return { style, cover: covers.length ? Math.min(...covers) : Infinity };
    }).sort((a, b) => a.cover - b.cover);
    let releaseIndex = 0;
    for (const row of styleRows) {
      if (result.length >= remainingSlots) break;
      if (usedStyles.has(displayStyle(row.style))) continue;
      const release = availableReleases[releaseIndex++];
      const liters = release?.workLiters || 2500;
      result.push({
        id: `weekly-brew:${week}:${row.style}`,
        kind: "brew",
        status: "recommended",
        date: addDays(week, 1),
        style: row.style,
        tankId: "",
        liters,
        reason: Number.isFinite(row.cover)
          ? `הכיסוי הכולל הצפוי הוא מהנמוכים ביותר (${row.cover.toFixed(1)} שבועות)`
          : "יש קיבולת בישול פנויה השבוע",
      } as BrewAction);
      usedStyles.add(displayStyle(row.style));
    }
    return result;
  }, [
    engineBrew,
    availableTankCount,
    current.brews,
    coreProducts,
    availableReleases,
    week,
    productionBaselineWorkspace.committedForecast,
  ]);

  const recommendedTruckSlots = useMemo(() => {
    const manifest = ship.flatMap((a) => a.pallets ?? []);
    if (!manifest.length) return 0;
    try {
      return calcTruckSlots(manifest);
    } catch {
      return 0;
    }
  }, [ship]);
  const decidedTruckSlots = () => {
    try {
      const manifest = (current.deliveries ?? []).flatMap((d) => {
        const p = product(d.productId);
        return p ? projectedPallets(p, d.quantity, d.id).map((x) => x.pallet) : [];
      });
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch {
      return 0;
    }
  };
  const draftTruckSlots = (qty: Record<string, number>) => {
    try {
      const manifest = coreProducts.flatMap((p) =>
        projectedPallets(
          p,
          Math.max(0, qty[`ship:${p.id}`] ?? 0),
          `draft:${week}:${p.id}`,
        ).map((x) => x.pallet),
      );
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch {
      return Infinity;
    }
  };

  function startEdit(kind: Kind) {
    setEditing(kind);
    setMessage("");
    const qty: Record<string, number> = {};
    if (kind === "delivery")
      shipmentRows.forEach((r) => {
        qty[`ship:${r.p.id}`] = r.decidedQty;
      });
    if (kind === "packaging") {
      current.packaging.forEach((r) => {
        qty[`saved:${r.id}`] = r.quantity;
      });
      pack.forEach((a) => {
        qty[`rec:${a.id}`] = 0;
      });
    }
    if (kind === "brew") {
      const drafts: Record<string, BrewDraft> = {};
      current.brews.forEach((b) => {
        drafts[`saved:${b.id}`] = { style: b.style, liters: b.liters };
      });
      brew.forEach((a) => {
        drafts[`rec:${a.id}`] = { style: a.style, liters: a.liters };
      });
      setBrewDraft(drafts);
    }
    setDraftQty(qty);
  }

  async function saveEdited(kind: Kind) {
    setBusy(true);
    setMessage("");
    try {
      let next = structuredClone(current);
      if (kind === "delivery") {
        if (draftTruckSlots(draftQty) > MAX_TRUCK_SLOTS)
          throw new Error(`המשלוח חורג מ־${MAX_TRUCK_SLOTS} מקומות במשאית`);
        const date = current.deliveries?.[0]?.dispatchDate ?? ship[0]?.date ?? addDays(week, 1);
        const deliveries: DeliveryPlan[] = [];
        for (const p of coreProducts) {
          const quantity = Math.max(0, Number(draftQty[`ship:${p.id}`] ?? 0));
          if (quantity)
            deliveries.push({
              id: crypto.randomUUID(),
              productId: p.id,
              quantity,
              dispatchDate: date,
              arrivalDate: date,
              truckId: `truck:${date}`,
              pallets: [],
            });
        }
        next.deliveries = deliveries;
        next.deliveryDates = deliveries.length ? [date] : [];
      } else if (kind === "packaging") {
        next.packaging = next.packaging
          .map((r) => ({
            ...r,
            quantity: Math.max(0, Number(draftQty[`saved:${r.id}`] ?? r.quantity)),
          }))
          .filter((r) => r.quantity > 0);
        for (const a of pack) {
          if (next.packaging.some((x) => x.id === a.id)) continue;
          const quantity = Math.max(0, Number(draftQty[`rec:${a.id}`] ?? 0));
          if (!quantity) continue;
          next = adoptAction(next, { ...a, quantity } as PlanningAction);
          const added = next.packaging[next.packaging.length - 1];
          const t = tanks.find((x) => x.id === added.tankId);
          const p = product(added.productId);
          if (t && p && committedRemainingLiters(t) - added.quantity * litersPerUnit(p) < 20)
            added.emptyTank = true;
        }
      } else {
        next.brews = next.brews.map((b) => ({
          ...b,
          tankId: "",
          ...(brewDraft[`saved:${b.id}`] ?? {}),
        }));
        for (const a of brew)
          if (!next.brews.some((x) => x.id === a.id)) {
            const d = brewDraft[`rec:${a.id}`];
            if (d?.style && d.liters > 0)
              next.brews.push({
                id: a.id,
                style: d.style,
                tankId: "",
                date: a.date,
                liters: d.liters,
              });
          }
      }
      next.changeReason = `עריכת החלטת ${
        kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"
      } שבועית`;
      await saveWeek(next);
      setEditing(null);
      setMessage("ההחלטה השבועית נשמרה.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  async function accept(kind: Kind) {
    setBusy(true);
    setMessage("");
    try {
      let next = structuredClone(current);
      if (kind === "delivery") {
        next.deliveries = [];
        next.deliveryDates = [];
        for (const a of ship) next = adoptAction(next, a);
      } else if (kind === "packaging") {
        next.packaging = [];
        for (const a of pack) {
          next = adoptAction(next, a);
          const added = next.packaging[next.packaging.length - 1];
          const t = tanks.find((x) => x.id === added.tankId);
          const p = product(added.productId);
          if (t && p && committedRemainingLiters(t) - added.quantity * litersPerUnit(p) < 20)
            added.emptyTank = true;
        }
      } else {
        next.brews = brew.map((a) => ({
          id: a.id,
          style: a.style,
          tankId: "",
          date: a.date,
          liters: a.liters,
        }));
      }
      next.changeReason = `אישור המלצת ${
        kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"
      } שבועית`;
      await saveWeek(next);
      setMessage("ההמלצה החליפה את ההחלטה השבועית.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  const stepPallets = (p: (typeof coreProducts)[number], delta: number) =>
    setDraftQty((q) => {
      const key = `ship:${p.id}`;
      const next = {
        ...q,
        [key]: Math.max(0, (q[key] ?? 0) + delta * palletSize(p)),
      };
      if (delta > 0 && draftTruckSlots(next) > MAX_TRUCK_SLOTS) {
        setMessage(`המשאית מלאה: ${MAX_TRUCK_SLOTS}/${MAX_TRUCK_SLOTS} מקומות`);
        return q;
      }
      setMessage("");
      return next;
    });

  const coverText = (before: number | null, after: number | null) => {
    if (before === null) return "—";
    if (after === null || Math.abs(after - before) < 0.05) return `${before.toFixed(1)} שב׳`;
    return `${before.toFixed(1)} ← ${after.toFixed(1)} שב׳`;
  };

  return (
    <section className="bp-weekly-planner">
      <div className="bp-section-heading">
        <div>
          <h2>המלצות שבועיות</h2>
          <p className="bp-muted">
            ההמלצה נשארת להשוואה מול ההחלטה. רק פער שמשאיר את הכיסוי מתחת ליעד מסומן כאזהרה.
          </p>
        </div>
      </div>
      <div className="bp-week-picker">
        {Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => (
          <button
            key={w}
            aria-pressed={week === w}
            onClick={() => {
              setWeek(w);
              setEditing(null);
            }}
          >
            שבוע {weekNumber(w)}
            <small>{shortDate(w)}</small>
          </button>
        ))}
      </div>

      {weekHolidays.length > 0 && (
        <div className="bp-week-events">
          <b>חגים / מגבלות השבוע</b>
          {weekHolidays.map((h) => (
            <span key={`${h.date}:${h.title}`}>
              {shortDate(h.date)} · {h.title}{h.closed ? " · סגור" : ""}
            </span>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="bp-week-alerts">
          <b>אזהרות לתוכנית</b>
          {warnings.map((w) => <span key={w}>⚠ {w}</span>)}
        </div>
      )}

      <div className="bp-week-recommendations">
        <article className="bp-week-rec-card bp-week-shipment-card">
          <header>
            <div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div>
            <b>{recommendedTruckSlots}/{MAX_TRUCK_SLOTS} מקומות בהמלצה</b>
          </header>
          <p className="bp-rec-principle">
            כאן הכיסוי הוא כיסוי טמפו צפוי לסוף השבוע בלבד. מלאי המבשלה הוא מקור למשלוח ולכן אינו נספר בתוך כיסוי טמפו.
          </p>
          <div className="bp-shipment-plan-table">
            <div className="bp-shipment-plan-head">
              <span>מקט</span><span>מומלץ</span><span>נקבע</span><span>זמין / תכנון</span>
            </div>
            {shipmentRows.map((r) => (
              <div className={`bp-shipment-plan-row is-${r.severity} gap-${r.gap}`} key={r.p.id}>
                <span>
                  <b>{displayStyle(r.p.style)}</b>
                  <small>{r.p.type === "crates" ? "ארגזים" : "חביות"} · כיסוי טמפו סוף שבוע {coverText(r.before, r.after)}</small>
                </span>
                <span>{r.recPallets} מש׳<small>{r.recSlots} מק׳ במשאית</small></span>
                <span>
                  {editing === "delivery" ? (
                    <div className="bp-stepper">
                      <button type="button" onClick={() => stepPallets(r.p, -1)}>−</button>
                      <b>{Math.round((draftQty[`ship:${r.p.id}`] ?? 0) / palletSize(r.p))}</b>
                      <button type="button" onClick={() => stepPallets(r.p, 1)}>+</button>
                      <small>משטחים</small>
                    </div>
                  ) : (
                    <>
                      {r.decidedPallets} מש׳
                      {r.gap !== "none" && (
                        <small className={`bp-gap bp-gap-${r.gap}`}>
                          חסרים {r.recPallets - r.decidedPallets} מש׳ לעומת ההמלצה והכיסוי עדיין מתחת ליעד
                        </small>
                      )}
                    </>
                  )}
                </span>
                <span>{r.availability.physicalPallets} מש׳<small>פיזי · ועוד {r.availability.plannedPallets} מש׳ מתכנון</small></span>
              </div>
            ))}
          </div>
          <div className="bp-saved-summary">החלטה נוכחית: {decidedTruckSlots()}/{MAX_TRUCK_SLOTS} מקומות.</div>
          <div className="bp-actions">
            {editing === "delivery" ? (
              <>
                <button disabled={busy} onClick={() => saveEdited("delivery")}>שמירת החלטת המשלוח</button>
                <button onClick={() => setEditing(null)}>ביטול</button>
              </>
            ) : (
              <>
                <button disabled={disabled || busy || recommendedTruckSlots < MAX_TRUCK_SLOTS} onClick={() => accept("delivery")}>החלף בהחלטת 12/12 המומלצת</button>
                <button disabled={disabled || busy} onClick={() => startEdit("delivery")}>עריכת המשלוח</button>
              </>
            )}
          </div>
        </article>

        <article className="bp-week-rec-card">
          <header>
            <div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div>
            <b>{pack.length} המלצות · {recommendedPackagingDays}/{maxPackagingRuns} ימי אריזה בהמלצה</b>
          </header>
          <p className="bp-rec-principle">
            כאן הכיסוי הוא כיסוי כולל צפוי לסוף השבוע. החלטת משלוח של השבוע כבר משתתפת בחישוב האריזה, אבל המלצת אריזה שלא אושרה לא משתתפת.
          </p>
          <div className="bp-shipment-plan-table">
            <div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי כולל</span><span>מומלץ</span><span>נקבע</span></div>
            {packagingRows.map((r) => (
              <div className={`bp-shipment-plan-row is-${r.severity} gap-${r.gap}`} key={r.p.id}>
                <span><b>{displayStyle(r.p.style)}</b><small>{r.p.type === "crates" ? "ארגזים" : "חביות"}{r.tankText ? ` · מיכל ${r.tankText}` : ""}</small></span>
                <span>{coverText(r.before, r.after)}</span>
                <span>{fmt(r.recommendedQty)}</span>
                <span>
                  {fmt(r.decidedQty)}
                  {r.gap !== "none" && (
                    <small className={`bp-gap bp-gap-${r.gap}`}>
                      חסרים {fmt(r.recommendedQty - r.decidedQty)} לעומת ההמלצה והכיסוי עדיין מתחת ליעד
                    </small>
                  )}
                </span>
              </div>
            ))}
          </div>

          {editing === "packaging" && (
            <div className="bp-decided-list">
              <b>עריכת החלטות האריזה</b>
              {current.packaging.map((r) => {
                const p = product(r.productId);
                const value = draftQty[`saved:${r.id}`] ?? r.quantity;
                return (
                  <div className={`bp-rec-line ${value === 0 ? "is-muted" : ""}`} key={r.id}>
                    <b>{p ? displayStyle(p.style) : r.productId} · {p?.type === "crates" ? "ארגזים" : "חביות"}</b>
                    <input type="number" min="0" value={value} onChange={(e) => setDraftQty((q) => ({ ...q, [`saved:${r.id}`]: Math.max(0, Number(e.target.value)) }))}/>
                    <button type="button" onClick={() => setDraftQty((q) => ({ ...q, [`saved:${r.id}`]: value === 0 ? r.quantity : 0 }))}>{value === 0 ? "בטל הסרה" : "הסר"}</button>
                  </div>
                );
              })}
              {pack.filter((a) => !current.packaging.some((x) => x.id === a.id)).map((a) => {
                const p = product(a.productId);
                const value = draftQty[`rec:${a.id}`] ?? 0;
                return (
                  <div className={`bp-rec-line ${value === 0 ? "is-muted" : ""}`} key={a.id}>
                    <b>{p ? displayStyle(p.style) : a.productId} · מיכל {a.allocations[0]?.number}</b>
                    <input type="number" min="0" max={a.quantity} value={value} onChange={(e) => setDraftQty((q) => ({ ...q, [`rec:${a.id}`]: Math.max(0, Math.min(a.quantity, Number(e.target.value))) }))}/>
                    <button type="button" onClick={() => setDraftQty((q) => ({ ...q, [`rec:${a.id}`]: value > 0 ? 0 : a.quantity }))}>{value > 0 ? "בטל הוספה" : `הוסף ${fmt(a.quantity)}`}</button>
                  </div>
                );
              })}
              <small>בשבוע הזה כבר נוצלו {usedPackagingRuns} ימי אריזה; נשארו {remainingPackagingRuns} לפי ההחלטה הנוכחית.</small>
            </div>
          )}

          <div className="bp-actions">
            {editing === "packaging" ? (
              <>
                <button disabled={busy} onClick={() => saveEdited("packaging")}>שמירת החלטת האריזה</button>
                <button onClick={() => setEditing(null)}>ביטול</button>
              </>
            ) : (
              <>
                <button disabled={disabled || busy || !pack.length} onClick={() => accept("packaging")}>החלף בהחלטת האריזה המומלצת</button>
                <button disabled={disabled || busy} onClick={() => startEdit("packaging")}>עריכת האריזות</button>
              </>
            )}
          </div>
        </article>

        <article className="bp-week-rec-card">
          <header>
            <div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div>
            <b>{availableTankCount} מיכלים זמינים במהלך השבוע</b>
          </header>
          <p className="bp-rec-principle">בישולים קודמים תופסים מיכלים; ריקונים שנקבעו משחררים אותם אחרי הניקיון.</p>
          <div className="bp-decided-list">
            <b>החלטות שנקבעו</b>
            {current.brews.length ? current.brews.map((b) => (
              <div className="bp-rec-line" key={b.id}>
                <b>{displayStyle(b.style)} · {fmt(b.liters)} ל׳</b><span>טרם שובץ למיכל</span>
                {editing === "brew" && <BrewEditRow value={brewDraft[`saved:${b.id}`] ?? { style: b.style, liters: b.liters }} onChange={(v) => setBrewDraft((d) => ({ ...d, [`saved:${b.id}`]: v }))}/>} 
              </div>
            )) : <small>טרם נקבע</small>}
          </div>
          <div className="bp-decided-list">
            <b>המלצת המערכת</b>
            {brew.length ? brew.map((a) => (
              <div className="bp-rec-line" key={a.id}>
                <b>{displayStyle(a.style)} · {fmt(a.liters)} ל׳</b><span>{a.reason}</span>
                {editing === "brew" && <BrewEditRow value={brewDraft[`rec:${a.id}`] ?? { style: a.style, liters: a.liters }} onChange={(v) => setBrewDraft((d) => ({ ...d, [`rec:${a.id}`]: v }))}/>} 
              </div>
            )) : <small>אין המלצת בישול נוספת</small>}
          </div>
          <div className="bp-actions">
            {editing === "brew" ? (
              <>
                <button disabled={busy} onClick={() => saveEdited("brew")}>שמירת החלטת הבישול</button>
                <button onClick={() => setEditing(null)}>ביטול</button>
              </>
            ) : (
              <>
                <button disabled={disabled || busy || !brew.length} onClick={() => accept("brew")}>החלף בהחלטת הבישול המומלצת</button>
                <button disabled={disabled || busy} onClick={() => startEdit("brew")}>עריכת הבישולים</button>
              </>
            )}
          </div>
        </article>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function BrewEditRow({ value, onChange }: { value: BrewDraft; onChange: (value: BrewDraft) => void }) {
  return (
    <div className="bp-brew-edit-row">
      <label>
        סגנון
        <select value={CORE_STYLES.some((s) => sameStyle(s, value.style)) ? displayStyle(value.style) : value.style} onChange={(e) => onChange({ ...value, style: e.target.value })}>
          {CORE_STYLES.map((s) => <option key={s} value={s}>{displayStyle(s)}</option>)}
        </select>
      </label>
      <label>
        ליטרים
        <input type="number" min="1" value={value.liters || ""} onChange={(e) => onChange({ ...value, liters: Number(e.target.value) })}/>
      </label>
    </div>
  );
}
