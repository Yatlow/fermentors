import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import {
  addDays,
  tanksFrom,
  weekStart,
  type Settings,
} from "../../SERVICES/planning/planningEngine";
import {
  useHolidays,
  usePlanning,
  usePlanningToday,
} from "../../SERVICES/planning/usePlanning";
import { planningWorkspace } from "../../SERVICES/planning/workspace";
import { recommendationSettings } from "../../SERVICES/planning/planningPresentation";
import PlanningBoard from "./PlanningBoard";
import PlanningData from "./PlanningData";
import PlanningStock from "./PlanningStock";
import PlanningReview from "./PlanningReview";
import "./planning.css";

export const PLANNING_TABS = [
  ["stock", "מלאי"],
  ["calendar", "לוח עבודה"],
  ["data", "נתונים"],
  ["settings", "הגדרות"],
  ["review", "תכנון מול ביצוע"],
] as const;
export type PlanningTab = (typeof PLANNING_TABS)[number][0];

export default function PlanningView({
  brews,
  canEdit,
  tab,
}: {
  brews: Fermentor[];
  canEdit: boolean;
  tab: PlanningTab;
  onTabChange: (tab: PlanningTab) => void;
}) {
  const today = usePlanningToday();
  const productionTanks = useMemo(
    () => brews.filter((t) => Number(t.tankNumber) !== 1),
    [brews],
  );
  const data = usePlanning(today, productionTanks);
  const { settings, plans, pallets, actuals } = data;
  const { holidays, error: holidayError } = useHolidays(
    weekStart(today),
    addDays(weekStart(today), 83),
  );
  const tanks = useMemo(
    () => tanksFrom(productionTanks, settings, actuals),
    [productionTanks, settings, actuals],
  );
  const workspace = useMemo(
    () =>
      planningWorkspace(
        recommendationSettings(settings),
        pallets,
        tanks,
        plans,
        actuals,
        productionTanks,
        today,
        holidays,
        data.actualShipments,
      ),
    [
      settings,
      pallets,
      tanks,
      plans,
      actuals,
      productionTanks,
      today,
      holidays,
      data.actualShipments,
    ],
  );
  const [message, setMessage] = useState("");
  const disabled = !canEdit || data.loading || data.offline || !!data.error;
  async function saveSettings(settings: Settings) {
    await data.saveSettings(settings);
    setMessage("הנתונים נשמרו");
  }
  return (
    <section className="brew-planning" dir="rtl">
      {data.loading && !data.error && <p role="status">טוען את לוח העבודה…</p>}
      {data.error && (
        <p role="alert" className="bp-alert">
          טעינת הנתונים נכשלה: {data.error}
        </p>
      )}
      {data.offline && <p role="status">ממתין לחיבור לשרת לפני שמירה.</p>}
      {message && (tab === "data" || tab === "settings") && (
        <p role="status" className="bp-success">
          {message}
        </p>
      )}
      {!data.loading && !data.error && (
        <>
          {tab === "stock" && (
            <PlanningStock
              settings={settings}
              pallets={pallets}
              today={today}
              actions={workspace.actions}
              plans={workspace.effectivePlans}
              needs={workspace.needs}
            />
          )}
          {tab === "calendar" && (
            <>
              {holidayError && (
                <details>
                  <summary>לוח החגים לא נטען</summary>
                  {holidayError}
                </details>
              )}
              <PlanningBoard
                settings={settings}
                plans={plans}
                tanks={tanks}
                brews={productionTanks}
                actuals={actuals}
                shipments={data.actualShipments}
                today={today}
                holidays={holidays}
                workspace={workspace}
                disabled={disabled}
                saveWeek={data.saveWeek}
              />
            </>
          )}
          {(tab === "data" || tab === "settings") && (
            <PlanningData
              key={tab}
              mode={tab}
              settings={settings}
              today={today}
              disabled={disabled}
              save={saveSettings}
            />
          )}
          {tab === "review" && (
            <>
              <details>
                <summary>מי שומר את תמונות המצב?</summary>
                <p>
                  כל החלטה נשמרת כשלוחצים על שמירה. פונקציות Firebase נפרדות
                  מצלמות את ההחלטות בימי שישי ובפתיחת השבוע, ורק לאחר התקנתן
                  ופריסתן.
                </p>
                <p>
                  המלצות שלא אושרו משתתפות בתחזית בלוח, אך אינן החלטות שמורות
                  בדוח הזה. אין אישור אוטומטי בשם המתכנן.
                </p>
                <p>
                  {data.snapshots.length
                    ? "התקבלו תמונות מצב מהשרת."
                    : "לא התקבלו תמונות מצב בטווח הנוכחי. יש לבדוק את התקנת הפונקציות; אין להסיק שהשמירה המתוזמנת פעילה."}
                </p>
              </details>
              <PlanningReview
                settings={settings}
                plans={plans}
                actuals={actuals}
                snapshots={data.snapshots}
                error={data.snapshotError}
                today={today}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
