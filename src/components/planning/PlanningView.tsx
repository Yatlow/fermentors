import BeerLoader from "../general/Loading";
import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { addDays, tanksFrom, weekStart, type Settings } from "../../SERVICES/planning/planningEngine";
import { useHolidays, usePlanning, usePlanningToday } from "../../SERVICES/planning/usePlanning";
import { planningWorkspace } from "../../SERVICES/planning/workspace";
import { recommendationSettings } from "../../SERVICES/planning/planningPresentation";
import PlanningBoard from "./PlanningBoard";
import PlanningData from "./PlanningData";
import PlanningStock from "./PlanningStock";
import PlanningReview from "./PlanningReview";
import PlanningTanks from "./PlanningTanks";
import PlanningWeeklyRecommendations from "./PlanningWeeklyRecommendations";
import "./planning.css";

export const PLANNING_TABS = [
  ["stock", "מלאי"],
  ["data", "הזנת נתונים"],
  ["calendar", "המלצות שבועיות"],
  ["schedule", "לוח עבודה יומי"],
  ["settings", "הגדרות"],
  ["tanks", "מיכלים ותזמון"],
  ["review", "תכנון מול ביצוע"],
] as const;
export type PlanningTab = (typeof PLANNING_TABS)[number][0];

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
  const workspace = useMemo(() => planningWorkspace(recommendationSettings(settings), pallets, tanks, plans, actuals, productionTanks, today, holidays, data.actualShipments), [settings, pallets, tanks, plans, actuals, productionTanks, today, holidays, data.actualShipments]);
  const [message, setMessage] = useState("");
  const disabled = !canEdit || data.loading || data.offline || !!data.error;

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }

  return (
    <section className="brew-planning" dir="rtl">
      {data.loading && !data.error && 
      <div role="status"><BeerLoader message="טוען את לוח העבודה…" /></div>}
      {data.error && <p role="alert" className="bp-alert">טעינת הנתונים נכשלה: {data.error}</p>}
      {data.offline && <p role="status">ממתין לחיבור לשרת.</p>}
      {message && (tab === "data" || tab === "settings") && <p role="status" className="bp-success">{message}</p>}

      {!data.loading && !data.error && <>
        {tab === "stock" && <PlanningStock settings={settings} pallets={pallets} today={today} actions={workspace.actions} plans={plans}/>}

        {tab === "calendar" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningWeeklyRecommendations
            settings={settings}
            plans={plans}
            tanks={tanks}
            sources={productionTanks}
            pallets={pallets}
            actuals={actuals}
            shipments={data.actualShipments}
            holidays={holidays}
            today={today}
            disabled={disabled}
            saveWeek={data.saveWeek}
            onOpenCoolerMap={onOpenCoolerMap}
          />
        </>}

        {tab === "schedule" && <>
          {holidayError && <details><summary>לוח החגים לא נטען</summary>{holidayError}</details>}
          <PlanningBoard
            settings={settings}
            plans={plans}
            tanks={tanks}
            brews={productionTanks}
            pallets={pallets}
            actuals={actuals}
            shipments={data.actualShipments}
            today={today}
            holidays={holidays}
            disabled={disabled}
            saveWeek={data.saveWeek}
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
