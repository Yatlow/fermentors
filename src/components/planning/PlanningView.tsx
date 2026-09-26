import BeerLoader from "../general/Loading";
import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { addDays, tanksFrom, weekStart, type Settings } from "../../SERVICES/planning/planningEngine";
import { withTentativeFiveWeekTanks } from "../../SERVICES/planning/tentativePackaging";
import { useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";
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
import PlanningGantt from "./PlanningGantt";
import type { PlanningTab } from "./planningTabs";
import "./planning.css";
import "./planningEnhancements.css";
import "./planningFiveWeek.css";
import "./planningFiveWeekCalendarSpacing.css";
import "./planningGantt.css";

export default function PlanningView({ brews, canEdit, tab, onOpenCoolerMap }: {
  brews: Fermentor[];
  canEdit: boolean;
  tab: PlanningTab;
  onTabChange: (tab: PlanningTab) => void;
  onOpenCoolerMap?: () => void;
}) {
  const today = usePlanningToday();
  const productionTanks = useMemo(() => brews.filter((t) => Number(t.tankNumber) !== 1), [brews]);

  // planningWeeks stays loaded for the daily-work badge on every planning tab.
  // Heavy datasets are attached only where the rendered tab actually consumes them.
  const readScope = useMemo<PlanningReadScope>(() => ({
    plans: true,
    pallets: tab === "stock" || tab === "calendar" || tab === "fiveWeeks" || tab === "schedule",
    actuals: tab === "calendar" || tab === "fiveWeeks" || tab === "schedule" || tab === "tanks" || tab === "review",
    shipments: tab === "calendar" || tab === "fiveWeeks" || tab === "schedule",
    snapshots: tab === "review",
  }), [tab]);

  const data = usePlanning(today, productionTanks, readScope);
  const { settings, plans, pallets, actuals } = data;
  const { holidays, error: holidayError } = useHolidays(weekStart(today), addDays(weekStart(today), 83));
  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);

  // Planning rows already own their batch identity. Do not rewrite a planned
  // row from whatever batch currently occupies its target tank: a tank can
  // legitimately still hold last week's fermenting batch while next week's
  // brew is already planned for it.
  const identityAlignedPlans = plans;
  const [message, setMessage] = useState("");
  const disabled = !canEdit || data.loading || data.offline || !!data.error;

  const executionPlans = useMemo(
    () => plansAfterActualPackagingCompletion(identityAlignedPlans, settings.products, actuals, productionTanks),
    [identityAlignedPlans, settings.products, actuals, productionTanks],
  );

  const weeklyPlans = useMemo(
    () => pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products),
    [executionPlans, data.actualShipments, settings.products],
  );

  const calendarSettings = useMemo(
    () => settingsAfterActualShipments(settings, data.actualShipments, today),
    [settings, data.actualShipments, today],
  );

  const fiveWeekPlans = useMemo(
    () => withTentativeFiveWeekTanks(identityAlignedPlans, tanks, calendarSettings),
    [identityAlignedPlans, tanks, calendarSettings],
  );

  const pendingDailyWork = useMemo(() => {
    const firstWeek = weekStart(today);
    const horizonEnd = addDays(firstWeek, 34);
    const upcomingPlans = identityAlignedPlans.filter((plan) => plan.id >= firstWeek && plan.id <= horizonEnd);
    const brewsToAssign = upcomingPlans.reduce(
      (sum, plan) => sum + plan.brews.filter((brew) => !brew.tankId).length,
      0,
    );
    const packagingToAssign = upcomingPlans.reduce(
      (sum, plan) => sum + plan.packaging.filter((run) => run.quantity > 0 && !run.date).length,
      0,
    );
    return { brews: brewsToAssign, packaging: packagingToAssign, total: brewsToAssign + packagingToAssign };
  }, [identityAlignedPlans, today]);

  useEffect(() => {
    const applyBadge = () => {
      const nav = document.querySelector<HTMLElement>('nav[aria-label="תכנון"]');
      const button = Array.from(nav?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((item) => item.textContent?.includes("לוח עבודה יומי"));
      if (!button) return;
      if (pendingDailyWork.total > 0) {
        button.dataset.planningBadge = String(pendingDailyWork.total);
        button.title = `${pendingDailyWork.brews} בישולים ו־${pendingDailyWork.packaging} אריזות ממתינים לשיבוץ בחמשת השבועות הקרובים`;
        button.setAttribute("aria-label", `לוח עבודה יומי, ${pendingDailyWork.brews} בישולים ו־${pendingDailyWork.packaging} אריזות ממתינים לשיבוץ בחמשת השבועות הקרובים`);
      } else {
        delete button.dataset.planningBadge;
        button.removeAttribute("title");
        button.setAttribute("aria-label", "לוח עבודה יומי");
      }
    };
    applyBadge();
    const header = document.querySelector(".dashboard-header");
    const observer = new MutationObserver(() => requestAnimationFrame(applyBadge));
    if (header) observer.observe(header, { childList: true, subtree: true, attributes: true });
    const interval = window.setInterval(applyBadge, 1500);
    return () => { observer.disconnect(); window.clearInterval(interval); };
  }, [pendingDailyWork.brews, pendingDailyWork.packaging, pendingDailyWork.total]);

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }

  async function saveWeeklyPlan(
    next: Parameters<typeof data.saveWeek>[0],
    options?: Parameters<typeof data.saveWeek>[1],
  ) {
    const original = plans.find((week) => week.id === next.id);
    let merged = original ? mergeCompletedDeliveriesBack(original, next, data.actualShipments, settings.products) : next;
    if (original) merged = mergeCompletedPackagingBack(original, merged, settings.products, actuals, productionTanks);
    await data.saveWeek(merged, options);
  }

  return (
    <section className="brew-planning" dir="rtl">
      {data.loading && !data.error && <div role="status"><BeerLoader message="טוען את לוח העבודה…" /></div>}
      {data.error && <p role="alert" className="bp-alert">טעינת הנתונים נכשלה: {data.error}</p>}
      {data.offline && <p role="status">ממתין לחיבור לשרת.</p>}
      {message && (tab === "data" || tab === "settings") && <p role="status" className="bp-success">{message}</p>}

      {!data.loading && !data.error && <>
        {tab === "stock" && <PlanningStock settings={settings} pallets={pallets} today={today} plans={identityAlignedPlans}/>}
        {tab === "calendar" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningWeeklyReservations settings={calendarSettings} plans={weeklyPlans} historyPlans={identityAlignedPlans} tanks={tanks} sources={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} holidays={holidays} today={today} disabled={disabled} saveWeek={saveWeeklyPlan} onOpenCoolerMap={onOpenCoolerMap}/>
          <PlanningShipmentStatusPortal plans={identityAlignedPlans} shipments={data.actualShipments} products={settings.products}/>
        </>}
        {tab === "fiveWeeks" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningGantt
            settings={calendarSettings}
            plans={fiveWeekPlans}
            editorPlans={weeklyPlans}
            historyPlans={identityAlignedPlans}
            tanks={tanks}
            sources={productionTanks}
            pallets={pallets}
            actuals={actuals}
            shipments={data.actualShipments}
            holidays={holidays}
            today={today}
            disabled={disabled}
            canEdit={canEdit}
            saveWeek={saveWeeklyPlan}
            moveCalendarEvent={data.moveCalendarEvent}
            onOpenCoolerMap={onOpenCoolerMap}
          />
        </>}
        {tab === "schedule" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningBoard settings={settings} plans={identityAlignedPlans} tanks={tanks} brews={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} today={today} holidays={holidays} disabled={disabled} saveWeek={saveWeeklyPlan}/>
        </>}
        {(tab === "data" || tab === "settings") && <PlanningData key={tab} mode={tab} settings={settings} today={today} disabled={disabled} save={saveSettings}/>} 
        {tab === "tanks" && <PlanningTanks tanks={tanks} sources={productionTanks} plans={identityAlignedPlans} settings={settings} actuals={actuals} today={today}/>} 
        {tab === "review" && <PlanningReview settings={settings} plans={identityAlignedPlans} actuals={actuals} snapshots={data.snapshots} error={data.snapshotError} today={today}/>} 
      </>}
    </section>
  );
}
