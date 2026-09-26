import { Fragment, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  inventory,
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
import { shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { buildWeeklyPlanningModel, type WeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import PlanningFiveWeekOverview from "./PlanningFiveWeekOverview";

const CRATE_LITERS = 24 * 0.33;
const KEG_LITERS = 20;
const ROWS = [
  { id: "deliveries", label: "משלוחים" },
  { id: "packaging", label: "אריזות" },
  { id: "brews", label: "בישולים" },
  { id: "stock", label: "מלאי וכיסוי" },
] as const;

type RowId = (typeof ROWS)[number]["id"];
type GanttMode = "summary" | "calendar";
type SummaryItem = {
  key: string;
  title: string;
  meta: string;
  styleClass?: string;
  recommended?: boolean;
  stockKind?: "actual" | "projected" | "history";
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
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  holidays: Holiday[];
  today: string;
  disabled: boolean;
  saveWeek: (week: WeekPlan, options?: { allowClosedWeek?: boolean }) => Promise<void>;
  moveCalendarEvent: (
    sourceWeekId: string,
    targetWeekId: string,
    eventId: string,
    nextEvent: { id: string; title: string; startDate: string; endDate: string; type: "general"; note?: string },
  ) => Promise<void>;
};

const fmt = (value: number) => Math.round(value).toLocaleString("he-IL");
const cover = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} שב׳`;
const packageLiters = (quantity: number, type: "crates" | "kegs") => quantity * (type === "crates" ? CRATE_LITERS : KEG_LITERS);

export default function PlanningGantt(props: Props) {
  const { settings, plans, tanks, sources, pallets, actuals, shipments, holidays, today } = props;
  const [mode, setMode] = useState<GanttMode>("summary");
  const currentWeek = weekStart(today);
  const nextPlanningWeek = addDays(currentWeek, 7);
  const weekIds = useMemo(
    () => Array.from({ length: 5 }, (_, index) => addDays(currentWeek, (index - 1) * 7)),
    [currentWeek],
  );

  const simulations = useMemo(() => {
    const result = new Map<string, SimulatedWeek>();
    let effectivePlans = plans.map((plan) => structuredClone(plan));

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
      const saved = plans.find((plan) => plan.id === week);
      let workingPlan: WeekPlan = saved
        ? structuredClone(saved)
        : { ...emptyWeek(week), maxRuns: settings.preferredRuns };
      upsertPlan(workingPlan);

      let model = buildModel(week);
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
                source: "recommendation" as const,
                emptyTank: !all.slice(index + 1).some((later) => later.tankId === item.tankId),
              })),
            };
            upsertPlan(workingPlan);
            model = buildModel(week);
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
    }

    return result;
  }, [settings, pallets, tanks, plans, actuals, sources, today, weekIds, holidays, shipments, currentWeek]);

  const productFor = (id: string) => settings.products.find((product) => product.id === id);
  const planFor = (weekId: string) => plans.find((plan) => plan.id === weekId);

  function compactShipmentItems(weekId: string): SummaryItem[] {
    const decisions = (planFor(weekId)?.deliveries ?? []).filter((item) => item.quantity > 0);
    const recommended = decisions.length === 0 && weekId >= currentWeek;
    const recommendations = simulations.get(weekId)?.deliveryRecommendation ?? [];
    const source = decisions.length
      ? decisions.map((item) => ({ productId: item.productId, quantity: item.quantity }))
      : recommendations.map((item) => ({ productId: item.productId, quantity: item.quantity }));
    if (!source.length) return [];

    const grouped = new Map<string, string[]>();
    for (const item of source) {
      const product = productFor(item.productId);
      if (!product) continue;
      const style = displayStyle(product.style);
      const line = `${fmt(item.quantity)} ${product.type === "crates" ? "ארגזים" : "חביות"}`;
      grouped.set(style, [...(grouped.get(style) ?? []), line]);
    }
    const date = decisions.map((item) => item.dispatchDate).filter(Boolean).sort()[0];
    const parts = [...grouped.entries()].map(([style, lines]) => `${style}: ${lines.join(" + ")}`);
    if (date) parts.push(shortDate(date));

    return [{
      key: `delivery-summary:${weekId}`,
      title: "משלוח טמפו",
      meta: parts.join(" · "),
      recommended,
    }];
  }

  function packagingItems(weekId: string): SummaryItem[] {
    const decisions = (planFor(weekId)?.packaging ?? []).filter((item) => item.quantity > 0);
    if (decisions.length) {
      return decisions.map((item, index) => {
        const product = productFor(item.productId);
        const tank = tanks.find((candidate) => candidate.id === item.tankId);
        return {
          key: `pack:${item.id ?? index}`,
          title: product ? `${displayStyle(product.style)} · מיכל ${item.tankNumber ?? tank?.number ?? "?"}` : item.productId,
          meta: product ? `${fmt(item.quantity)} ${product.type === "crates" ? "ארגזים" : "חביות"} · ${fmt(packageLiters(item.quantity, product.type))} ל׳` : fmt(item.quantity),
          styleClass: product ? beerStyleClass(product.style).className : undefined,
        };
      });
    }
    if (weekId < currentWeek) return [];
    return (simulations.get(weekId)?.packagingRecommendation ?? []).map((item) => {
      const product = productFor(item.productId);
      return {
        key: `pack-rec:${item.id}`,
        title: `${product ? displayStyle(product.style) : item.productId} · מיכל ${item.tankNumber}`,
        meta: `${fmt(item.quantity)} ${product?.type === "crates" ? "ארגזים" : "חביות"} · ${fmt(item.quantity * (product ? (product.type === "crates" ? CRATE_LITERS : KEG_LITERS) : 1))} ל׳`,
        styleClass: product ? beerStyleClass(product.style).className : undefined,
        recommended: true,
      };
    });
  }

  function brewItems(weekId: string): SummaryItem[] {
    const decisions = (planFor(weekId)?.brews ?? []).filter((item) => item.liters > 0);
    if (decisions.length) {
      return decisions.map((item) => ({
        key: `brew:${item.id}`,
        title: `${displayStyle(item.style)} · מיכל ${tanks.find((tank) => tank.id === item.tankId)?.number ?? "?"}`,
        meta: `${fmt(item.liters)} ל׳ · ${shortDate(item.date)}`,
        styleClass: beerStyleClass(item.style).className,
      }));
    }
    if (weekId < currentWeek) return [];
    return (simulations.get(weekId)?.brewRecommendation ?? []).map((item, index) => ({
      key: `brew-rec:${weekId}:${item.style}:${index}`,
      title: `${displayStyle(item.style)} · מיכל ${item.tankNumber}`,
      meta: `${item.sizeLabel} · ${fmt(item.liters)} ל׳ · זמין ${shortDate(item.availableDate)}`,
      styleClass: beerStyleClass(item.style).className,
      recommended: true,
    }));
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
        const label = product.type === "crates" ? "ארגזים" : "חביות";
        const line = `${label} ${fmt(total)} (${cover(totalCover)})`;
        const style = displayStyle(product.style);
        grouped.set(style, [...(grouped.get(style) ?? []), line]);
      }
    } else {
      for (const row of simulations.get(weekId)?.model.weekStartRows.values() ?? []) {
        if (row.product.monthly <= 0) continue;
        const total = row.breweryUnits + (row.tempoUnits ?? 0);
        const label = row.product.type === "crates" ? "ארגזים" : "חביות";
        const line = `${label} ${fmt(total)} (${cover(row.totalCover)})`;
        const style = displayStyle(row.product.style);
        grouped.set(style, [...(grouped.get(style) ?? []), line]);
      }
    }

    const parts = [...grouped.entries()].map(([style, lines]) => `${style}: ${lines.join(" + ")}`);
    return parts.length ? [{
      key: `stock-summary:${weekId}`,
      title: weekId === currentWeek ? "מלאי נוכחי" : "פתיחת שבוע",
      meta: parts.join(" · "),
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
    const plan = simulations.get(weekId)?.effectivePlan ?? planFor(weekId);
    if (!plan) return { packaging: 0, brewing: 0 };
    const packaging = plan.packaging.reduce((sum, run) => {
      const product = productFor(run.productId);
      return sum + (product && run.quantity > 0 ? packageLiters(run.quantity, product.type) : 0);
    }, 0);
    return {
      packaging,
      brewing: plan.brews.reduce((sum, brew) => sum + Math.max(0, Number(brew.liters) || 0), 0),
    };
  }

  if (mode === "calendar") {
    return (
      <section className="bp-gantt-shell">
        <div className="bp-section-heading bp-gantt-heading">
          <div><h2>גאנט</h2><p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה.</p></div>
          <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
            <button type="button" aria-pressed={false} onClick={() => setMode("summary")}>סיכום שבועי</button>
            <button type="button" aria-pressed={true}>לוח גאנט</button>
          </div>
        </div>
        <div className="bp-gantt-calendar-host">
          <PlanningFiveWeekOverview {...props} />
        </div>
      </section>
    );
  }

  return (
    <section className="bp-gantt-shell">
      <div className="bp-section-heading bp-gantt-heading">
        <div><h2>גאנט</h2><p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה.</p></div>
        <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
          <button type="button" aria-pressed={true}>סיכום שבועי</button>
          <button type="button" aria-pressed={false} onClick={() => setMode("calendar")}>לוח גאנט</button>
        </div>
      </div>

      <div className="bp-gantt-legend" aria-label="מקרא">
        <span className="is-actual">● מלאי נוכחי / בפועל</span>
        <span className="is-projected">◌ צפי לפתיחת שבוע</span>
        <span className="is-recommendation">המלצה — מחושבת קדימה כאילו התקבלה</span>
      </div>

      <div className="bp-five-week-scroll">
        <div className="bp-five-week-grid bp-gantt-grid" role="table" aria-label="גאנט תכנון לחמישה שבועות">
          <div className="bp-five-week-corner" />
          {weekIds.map((weekId) => {
            const totals = weeklyTotals(weekId);
            return (
              <div key={`head:${weekId}`} className={`bp-five-week-head ${weekId === currentWeek ? "is-current" : ""} ${weekId === nextPlanningWeek ? "is-next" : ""}`}>
                <b>שבוע {weekNumber(weekId)}</b>
                <span>{shortDate(weekId)}–{shortDate(addDays(weekId, 6))}</span>
                {(totals.packaging > 0 || totals.brewing > 0) && <small>אריזה {fmt(totals.packaging)} ל׳ · בישול {fmt(totals.brewing)} ל׳</small>}
                {weekId === currentWeek && <small>השבוע</small>}
                {weekId === nextPlanningWeek && <small>שבוע התכנון הבא</small>}
              </div>
            );
          })}

          {ROWS.map((row) => (
            <Fragment key={row.id}>
              <div className={`bp-five-week-row-label is-${row.id}`}>{row.label}</div>
              {weekIds.map((weekId) => {
                const items = itemsFor(row.id, weekId);
                return (
                  <div className={`bp-five-week-cell is-${row.id}`} key={`${row.id}:${weekId}`}>
                    {items.map((item) => (
                      <article
                        className={`bp-five-week-item ${item.styleClass ?? ""} ${item.recommended ? "is-gantt-recommendation" : ""} ${item.stockKind ? `is-stock-${item.stockKind}` : ""}`}
                        key={item.key}
                      >
                        <b>{item.title}</b>
                        <small>{item.meta}</small>
                        {item.recommended && <span className="bp-gantt-rec-label">המלצה · טרם נקבע</span>}
                        {item.stockKind === "actual" && <span className="bp-gantt-stock-label">בפועל עכשיו</span>}
                        {item.stockKind === "projected" && <span className="bp-gantt-stock-label">צפי לפתיחת השבוע</span>}
                      </article>
                    ))}
                    {!items.length && <span className="bp-five-week-empty">—</span>}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
