import BeerLoader from "../general/Loading";
import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { addDays, tanksFrom, weekStart, type Settings } from "../../SERVICES/planning/planningEngine";
import { useHolidays, usePlanning, usePlanningToday } from "../../SERVICES/planning/usePlanning";
import {
  mergeCompletedDeliveriesBack,
  pendingPlansAfterActualShipments,
  settingsAfterActualShipments,
} from "../../SERVICES/planning/shipmentActuals";
import {
  mergeCompletedPackagingBack,
  plansAfterActualPackagingCompletion,
} from "../../SERVICES/planning/packagingActuals";
import PlanningBoard from "./PlanningBoard";
import PlanningData from "./PlanningData";
import PlanningStock from "./PlanningStock";
import PlanningReview from "./PlanningReview";
import PlanningTanks from "./PlanningTanks";
import PlanningWeeklyReservations from "./PlanningWeeklyReservations";
import PlanningShipmentStatusPortal from "./PlanningShipmentStatusPortal";
import PlanningFiveWeekOverview from "./PlanningFiveWeekOverview";
import type { PlanningTab } from "./planningTabs";
import "./planning.css";
import "./planningEnhancements.css";
import "./planningFiveWeek.css";

export default function PlanningView({ brews, canEdit, tab, onOpenCoolerMap }: {
  brews: Fermentor[];
  canEdit: boolean;
  tab: PlanningTab;
  onTabChange: (tab: PlanningTab) => void;
  onOpenCoolerMap?: () => void;
}) {
  const today = usePlanningToday();
  const productionTanks = useMemo(() => brews.filter((t) => Number(t.tankNumber) !== 1), [brews]);
  const data = usePlanning(today, productionTanks);
  const { settings, plans, pallets, actuals } = data;
  const { holidays, error: holidayError } = useHolidays(weekStart(today), addDays(weekStart(today), 83));
  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);
  const [message, setMessage] = useState("");
  const disabled = !canEdit || data.loading || data.offline || !!data.error;

  const executionPlans = useMemo(
    () => plansAfterActualPackagingCompletion(plans, settings.products, actuals, productionTanks),
    [plans, settings.products, actuals, productionTanks],
  );

  const weeklyPlans = useMemo(
    () => pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products),
    [executionPlans, data.actualShipments, settings.products],
  );

  const calendarSettings = useMemo(
    () => settingsAfterActualShipments(settings, data.actualShipments, today),
    [settings, data.actualShipments, today],
  );

  const pendingDailyWork = useMemo(() => {
    const nextWeekId = addDays(weekStart(today), 7);
    const nextWeek = executionPlans.find((plan) => plan.id === nextWeekId);
    const brewsToAssign = nextWeek?.brews.filter((brew) => !brew.tankId).length ?? 0;
    const packagingToAssign = nextWeek?.packaging.filter((run) => run.quantity > 0 && !run.date).length ?? 0;
    return {
      brews: brewsToAssign,
      packaging: packagingToAssign,
      total: brewsToAssign + packagingToAssign,
    };
  }, [executionPlans, today]);

  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="תכנון"]');
    const button = Array.from(nav?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((item) => item.textContent?.includes("לוח עבודה יומי"));
    if (!button) return;

    if (pendingDailyWork.total > 0) {
      button.dataset.planningBadge = String(pendingDailyWork.total);
      button.title = `${pendingDailyWork.brews} בישולים ו־${pendingDailyWork.packaging} אריזות ממתינים לשיבוץ`;
      button.setAttribute(
        "aria-label",
        `לוח עבודה יומי, ${pendingDailyWork.brews} בישולים ו־${pendingDailyWork.packaging} אריזות ממתינים לשיבוץ`,
      );
    } else {
      delete button.dataset.planningBadge;
      button.removeAttribute("title");
      button.setAttribute("aria-label", "לוח עבודה יומי");
    }

    return () => {
      delete button.dataset.planningBadge;
      button.removeAttribute("title");
      button.removeAttribute("aria-label");
    };
  }, [pendingDailyWork]);

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }

  async function saveWeeklyPlan(next: Parameters<typeof data.saveWeek>[0]) {
    const original = plans.find((week) => week.id === next.id);
    let merged = original
      ? mergeCompletedDeliveriesBack(original, next, data.actualShipments, settings.products)
      : next;
    if (original) {
      merged = mergeCompletedPackagingBack(
        original,
        merged,
        settings.products,
        actuals,
        productionTanks,
      );
    }
    await data.saveWeek(merged);
  }

  return (
    <section className="brew-planning" dir="rtl">
      {data.loading && !data.error &&
      <div role="status"><BeerLoader message="טוען את לוח העבודה…" /></div>}
      {data.error && <p role="alert" className="bp-alert">טעינת הנתונים נכשלה: {data.error}</p>}
      {data.offline && <p role="status">ממתין לחיבור לשרת.</p>}
      {message && (tab === "data" || tab === "settings") && <p role="status" className="bp-success">{message}</p>}

      {!data.loading && !data.error && <>
        {tab === "stock" && <PlanningStock settings={settings} pallets={pallets} today={today} plans={plans}/>}

        {tab === "calendar" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningWeeklyReservations
            settings={calendarSettings}
            plans={weeklyPlans}
            historyPlans={plans}
            tanks={tanks}
            sources={productionTanks}
            pallets={pallets}
            actuals={actuals}
            shipments={data.actualShipments}
            holidays={holidays}
            today={today}
            disabled={disabled}
            saveWeek={saveWeeklyPlan}
            onOpenCoolerMap={onOpenCoolerMap}
          />
          <PlanningShipmentStatusPortal
            plans={plans}
            shipments={data.actualShipments}
            products={settings.products}
          />
        </>}

        {tab === "fiveWeeks" && <PlanningFiveWeekOverview
          settings={calendarSettings}
          plans={weeklyPlans}
          tanks={tanks}
          today={today}
        />}

        {tab === "schedule" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningBoard
            settings={settings}
            plans={executionPlans}
            tanks={tanks}
            brews={productionTanks}
            pallets={pallets}
            actuals={actuals}
            shipments={data.actualShipments}
            today={today}
            holidays={holidays}
            disabled={disabled}
            saveWeek={saveWeeklyPlan}
          />
        </>}

        {(tab === "data" || tab === "settings") && <PlanningData key={tab} mode={tab} settings={settings} today={today} disabled={disabled} save={saveSettings}/>}

        {tab === "tanks" && <PlanningTanks tanks={tanks} sources={productionTanks} plans={plans} settings={settings} actuals={actuals} today={today}/>}

        {tab === "review" && <>
          <PlanningReview settings={settings} plans={plans} actuals={actuals} snapshots={data.snapshots} error={data.snapshotError} today={today}/>
        </>}
      </>}
    </section>
  );
}
