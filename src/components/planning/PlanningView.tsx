import BeerLoader from "../general/Loading";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Fermentor } from "../../App";
import { addDays, tanksFrom, weekStart, type Settings, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { withStablePackagingIdentity } from "../../SERVICES/planning/planIdentity";
import { withTentativeFiveWeekTanks } from "../../SERVICES/planning/tentativePackaging";
import { useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";
import { mergeCompletedDeliveriesBack, pendingPlansAfterActualShipments, settingsAfterActualShipments } from "../../SERVICES/planning/shipmentActuals";
import { mergeCompletedPackagingBack, plansAfterActualPackagingCompletion } from "../../SERVICES/planning/packagingActuals";
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


/**
 * Old planning documents can contain the same delivery row many times. Keep one
 * copy of an identical historical row; never add quantities, because the repeats
 * are corruption rather than separate planned shipments.
 */
export function withoutDuplicateDeliveries(week: WeekPlan): WeekPlan {
  if (!Array.isArray(week.deliveries) || week.deliveries.length < 2) return week;
  const seen = new Set<string>();
  const deliveries = week.deliveries.filter((delivery) => {
    const key = JSON.stringify(delivery, Object.keys(delivery).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deliveries.length === week.deliveries.length ? week : { ...week, deliveries };
}

export default function PlanningView({ brews, canEdit, tab, onOpenCoolerMap, onPendingDailyWorkChange }: {
  brews: Fermentor[];
  canEdit: boolean;
  tab: PlanningTab;
  onTabChange: (tab: PlanningTab) => void;
  onOpenCoolerMap?: () => void;
  onPendingDailyWorkChange?: (count: number) => void;
}) {
  const today = usePlanningToday();
  const productionTanks = useMemo(() => brews.filter((t) => Number(t.tankNumber) !== 1), [brews]);
  const stickyReadScope = useRef<PlanningReadScope>({ plans: true });
  const needsPallets = tab === "stock" || tab === "calendar" || tab === "fiveWeeks" || tab === "schedule";
  const needsActuals = tab === "calendar" || tab === "fiveWeeks" || tab === "schedule" || tab === "tanks" || tab === "review";
  const needsShipments = tab === "calendar" || tab === "fiveWeeks" || tab === "schedule";
  if (needsPallets) stickyReadScope.current.pallets = true;
  if (needsActuals) stickyReadScope.current.actuals = true;
  if (needsShipments) stickyReadScope.current.shipments = true;

  const readScope = useMemo<PlanningReadScope>(() => ({
    plans: true,
    pallets: stickyReadScope.current.pallets === true,
    actuals: stickyReadScope.current.actuals === true,
    shipments: stickyReadScope.current.shipments === true,
    snapshots: tab === "review",
  }), [tab, needsPallets, needsActuals, needsShipments]);

  const data = usePlanning(today, productionTanks, readScope);
  const { settings, plans, pallets, actuals } = data;
  const { holidays, error: holidayError } = useHolidays(weekStart(today), addDays(weekStart(today), 83));
  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);
  const identityAlignedPlans = useMemo(() => withStablePackagingIdentity(plans), [plans]);
  const [message, setMessage] = useState("");
  const disabled = !canEdit || data.loading || data.offline || !!data.error;
  const executionPlans = useMemo(() => (tab === "calendar" ? plansAfterActualPackagingCompletion(identityAlignedPlans, settings.products, actuals, productionTanks) : identityAlignedPlans), [tab, identityAlignedPlans, settings.products, actuals, productionTanks]);
  const weeklyPlans = useMemo(() => (tab === "calendar" ? pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products) : identityAlignedPlans), [tab, executionPlans, identityAlignedPlans, data.actualShipments, settings.products]);
  const calendarSettings = useMemo(() => ((tab === "calendar" || tab === "fiveWeeks") ? settingsAfterActualShipments(settings, data.actualShipments, today) : settings), [tab, settings, data.actualShipments, today]);
  const fiveWeekPlans = useMemo(() => (tab === "fiveWeeks" ? withTentativeFiveWeekTanks(identityAlignedPlans, tanks, calendarSettings) : identityAlignedPlans), [tab, identityAlignedPlans, tanks, calendarSettings]);
  const pendingDailyWork = useMemo(() => {
    const firstWeek = weekStart(today);
    // The badge represents pending daily assignments in the planning data, not
    // an arbitrary five-week window. The daily board can navigate later planned
    // weeks as well, so keep every current/future week in the count.
    const upcomingPlans = identityAlignedPlans.filter((plan) => plan.id >= firstWeek);
    const brewsToAssign = upcomingPlans.reduce((sum, plan) => sum + plan.brews.filter((brew) => !brew.tankId).length, 0);
    const packagingToAssign = upcomingPlans.reduce((sum, plan) => sum + plan.packaging.filter((run) => run.quantity > 0 && !run.date).length, 0);
    return { brews: brewsToAssign, packaging: packagingToAssign, total: brewsToAssign + packagingToAssign };
  }, [identityAlignedPlans, today]);

  useEffect(() => {
    onPendingDailyWorkChange?.(pendingDailyWork.total);
  }, [onPendingDailyWorkChange, pendingDailyWork.total]);

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }
  async function saveWeeklyPlan(next: Parameters<typeof data.saveWeek>[0], options?: Parameters<typeof data.saveWeek>[1]) {
    const original = identityAlignedPlans.find((week) => week.id === next.id);
    let merged = original ? mergeCompletedDeliveriesBack(original, next, data.actualShipments, settings.products) : next;
    if (original) merged = mergeCompletedPackagingBack(original, merged, settings.products, actuals, productionTanks);
    const allWithEditedWeek = identityAlignedPlans.map((week) => week.id === merged.id ? merged : week);
    if (!allWithEditedWeek.some((week) => week.id === merged.id)) allWithEditedWeek.push(merged);
    const canonical = withStablePackagingIdentity(allWithEditedWeek).find((week) => week.id === merged.id) ?? merged;
    await data.saveWeek(withoutDuplicateDeliveries(canonical), options);
  }

  return (
    <section className="brew-planning" dir="rtl">
      {data.loading && !data.error && <div role="status"><BeerLoader message="טוען את לוח העבודה…" /></div>}
      {data.error && <p role="alert" className="bp-alert">טעינת הנתונים נכשלה: {data.error}</p>}
      {data.offline && !data.loading && <p role="status">ממתין לחיבור לשרת.</p>}
      {message && (tab === "data" || tab === "settings") && <p role="status" className="bp-success">{message}</p>}
      {!data.loading && !data.error && <>
        {tab === "stock" && <PlanningStock settings={settings} pallets={pallets} today={today} plans={identityAlignedPlans}/>}
        {tab === "calendar" && <><>{holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}</><PlanningWeeklyReservations settings={calendarSettings} plans={weeklyPlans} historyPlans={identityAlignedPlans} tanks={tanks} sources={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} holidays={holidays} today={today} disabled={disabled} saveWeek={saveWeeklyPlan} onOpenCoolerMap={onOpenCoolerMap}/><PlanningShipmentStatusPortal plans={identityAlignedPlans} shipments={data.actualShipments} products={settings.products}/></>}
        {tab === "fiveWeeks" && <><>{holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}</><PlanningGantt settings={calendarSettings} plans={fiveWeekPlans} editorPlans={identityAlignedPlans} historyPlans={identityAlignedPlans} tanks={tanks} sources={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} holidays={holidays} today={today} disabled={disabled} canEdit={canEdit} saveWeek={saveWeeklyPlan} moveCalendarEvent={data.moveCalendarEvent} onOpenCoolerMap={onOpenCoolerMap}/></>}
        {tab === "schedule" && <><>{holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}</><PlanningBoard settings={settings} plans={identityAlignedPlans} tanks={tanks} brews={productionTanks} pallets={pallets} actuals={actuals} shipments={data.actualShipments} today={today} holidays={holidays} disabled={disabled} saveWeek={saveWeeklyPlan}/></>}
        {(tab === "data" || tab === "settings") && <PlanningData key={tab} mode={tab} settings={settings} today={today} disabled={disabled} save={saveSettings}/>} 
        {tab === "tanks" && <PlanningTanks tanks={tanks} sources={productionTanks} plans={identityAlignedPlans} settings={settings} actuals={actuals} today={today}/>} 
        {tab === "review" && <PlanningReview settings={settings} plans={identityAlignedPlans} actuals={actuals} snapshots={data.snapshots} error={data.snapshotError} today={today}/>} 
      </>}
    </section>
  );
}