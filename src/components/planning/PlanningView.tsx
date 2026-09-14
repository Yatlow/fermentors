import BeerLoader from "../general/Loading";
import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { addDays, tanksFrom, weekStart, type Settings } from "../../SERVICES/planning/planningEngine";
import { useHolidays, usePlanning, usePlanningToday } from "../../SERVICES/planning/usePlanning";
import { planningWorkspace } from "../../SERVICES/planning/workspace";
import { recommendationSettings } from "../../SERVICES/planning/planningPresentation";
import {
  mergeCompletedDeliveriesBack,
  pendingPlansAfterActualShipments,
  shipmentMatchesForPlans,
} from "../../SERVICES/planning/shipmentActuals";
import { brewSizeLabel } from "../../SERVICES/planning/productionCycle";
import PlanningBoard from "./PlanningBoard";
import PlanningData from "./PlanningData";
import PlanningStock from "./PlanningStock";
import PlanningReview from "./PlanningReview";
import PlanningTanks from "./PlanningTanks";
import PlanningWeeklyRecommendations from "./PlanningWeeklyRecommendations";
import "./planning.css";
import "./planningEnhancements.css";

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

  const weeklyPlans = useMemo(
    () => pendingPlansAfterActualShipments(plans, data.actualShipments, settings.products),
    [plans, data.actualShipments, settings.products],
  );
  const shipmentMatches = useMemo(
    () => shipmentMatchesForPlans(plans, data.actualShipments, settings.products),
    [plans, data.actualShipments, settings.products],
  );
  const thisWeekShipmentMatches = shipmentMatches.filter((match) =>
    match.week === weekStart(today) && match.status !== "pending",
  );

  async function saveSettings(next: Settings) {
    await data.saveSettings(next);
    setMessage("הנתונים נשמרו");
  }

  async function saveWeeklyPlan(next: Parameters<typeof data.saveWeek>[0]) {
    const original = plans.find((week) => week.id === next.id);
    const merged = original
      ? mergeCompletedDeliveriesBack(original, next, data.actualShipments, settings.products)
      : next;
    await data.saveWeek(merged);
  }

  function openEditorFromStyleChip(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.closest(".bp-week-sku")) return;
    const card = target.closest<HTMLElement>(".bp-week-rec-card");
    if (!card) return;
    const editButton = [...card.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("עריכת"));
    if (editButton && !editButton.disabled) editButton.click();
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

          {thisWeekShipmentMatches.length > 0 && <div className="bp-success" role="status">
            <b>משלוחים שבוצעו בפועל השבוע: {thisWeekShipmentMatches.length}</b>
            {thisWeekShipmentMatches.map((match) => <div key={`${match.week}:${match.planned.id}`}>
              משלוח {match.actual?.shipmentNumber ? `#${match.actual.shipmentNumber}` : "שבוצע"} · {match.status === "matched"
                ? match.score == null ? "זוהה לפי שבוע המשלוח" : `התאמה ${Math.round(match.score * 100)}% לתכנון`
                : `בוצע בפועל אך שונה מהתכנון (${Math.round((match.score ?? 0) * 100)}% התאמה)`}
            </div>)}
            <small>המשלוחים שבוצעו הוסרו רק מרשימת המשימות הפתוחות; ההחלטה המקורית נשמרת בהיסטוריה. אם יש משלוח נוסף השבוע הוא נשאר פתוח, ואם לא — ניתן לעבור לשבוע הבא ולסמן אותו במפה.</small>
          </div>}

          <div className="bp-brew-tank-options">
            <b>מקרא מיכלים לעריכה</b>
            <div className="bp-brew-tank-list">
              {tanks.map((tank) => <span className="bp-brew-tank-chip" key={`planning-key:${tank.id}`}>
                <b>מיכל {tank.number}</b><span>{brewSizeLabel(tank.liters, tank.number)}</span>
              </span>)}
            </div>
          </div>

          <div onClickCapture={openEditorFromStyleChip} className="bp-style-chip-edit-surface">
            <PlanningWeeklyRecommendations
              settings={settings}
              plans={weeklyPlans}
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
          </div>
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
