import BeerLoader from "../general/Loading";
import { useMemo, useState } from "react";
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
import type { PlanningTab } from "./planningTabs";
import "./planning.css";
import "./planningEnhancements.css";

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

  const markedOutsideCooler = useMemo(
    () => pallets.filter((pallet) => pallet.markedForShipment && pallet.zone !== "cooler").length,
    [pallets],
  );

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
      {markedOutsideCooler > 0 && <div className="bp-outside-shipment-warning" role="alert">
        <strong>⚠️ יש {markedOutsideCooler} {markedOutsideCooler === 1 ? "משטח מסומן" : "משטחים מסומנים"} למשלוח שאינם במקרר.</strong>
        <span>הם כבר נכללים בהחלטת המשלוח, אבל צריך להעביר אותם למקרר או לאזור ההעמסה לפני היציאה.</span>
        {onOpenCoolerMap && <button type="button" onClick={onOpenCoolerMap}>פתח מפת מקרר</button>}
      </div>}

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
