import { useMemo, useState } from "react";
import {
  addDays,
  weekNumber,
  weekStart,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import type { planningWorkspace } from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
const names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"];

export default function PlanningWeekGantt({
  settings,
  plans,
  tanks,
  workspace,
  today,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  workspace: Workspace;
  today: string;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const current = plans.find((w) => w.id === week);
  const recommendations = useMemo(
    () => workspace.actions.filter((a) => weekStart(a.date) === week),
    [workspace.actions, week],
  );
  const dates = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const productName = (id: string) => {
    const p = settings.products.find((x) => x.id === id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "בק׳" : "חב׳"}` : id;
  };

  const lanes = [
    {
      id: "delivery",
      label: "משלוח",
      cells: dates.map((date) => ({
        saved: (current?.deliveries ?? []).filter((x) => x.dispatchDate === date).map((x) => productName(x.productId)),
        rec: recommendations.filter((x) => x.kind === "delivery" && x.date === date).map((x) => x.kind === "delivery" ? productName(x.productId) : ""),
      })),
    },
    {
      id: "packaging",
      label: "אריזה",
      cells: dates.map((date) => ({
        saved: (current?.packaging ?? []).filter((x) => x.date === date).map((x) => `${productName(x.productId)} · מיכל ${tanks.find((t) => t.id === x.tankId)?.number ?? x.tankNumber ?? "?"}`),
        rec: recommendations.filter((x) => x.kind === "packaging" && x.date === date).map((x) => x.kind === "packaging" ? `${productName(x.productId)} · מיכל ${x.allocations[0]?.number ?? "?"}` : ""),
      })),
    },
    {
      id: "brew",
      label: "בישול",
      cells: dates.map((date) => ({
        saved: (current?.brews ?? []).filter((x) => x.date === date).map((x) => `${displayStyle(x.style)} · מיכל ${tanks.find((t) => t.id === x.tankId)?.number ?? x.tankId}`),
        rec: recommendations.filter((x) => x.kind === "brew" && x.date === date).map((x) => x.kind === "brew" ? `${displayStyle(x.style)} · מיכל ${x.tankId}` : ""),
      })),
    },
  ];

  return (
    <section className="bp-gantt-section">
      <div className="bp-section-heading">
        <div><h2>שיבוץ שבועי למנהל העבודה</h2><p className="bp-muted">מלא = החלטה שמורה · מקווקו = המלצה שעדיין אפשר לשבץ או לשנות. לכל סוג פעולה צבע קבוע.</p></div>
        <label>שבוע<select value={week} onChange={(e) => setWeek(e.target.value)}>{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <option key={w} value={w}>שבוע {weekNumber(w)} · {shortDate(w)}</option>)}</select></label>
      </div>
      <div className="bp-gantt" role="table" aria-label="גאנט שבועי">
        <div className="bp-gantt-head" />
        {dates.map((date, i) => <div className="bp-gantt-head" key={date}>{names[i]}<small>{shortDate(date)}</small></div>)}
        {lanes.flatMap((lane) => [
          <div className={`bp-gantt-label is-${lane.id}`} key={`${lane.id}:label`}>{lane.label}</div>,
          ...lane.cells.map((cell, i) => <div className={`bp-gantt-cell is-${lane.id}`} key={`${lane.id}:${dates[i]}`}>
            {cell.saved.map((text, j) => <span className={`bp-gantt-item is-saved is-${lane.id}`} key={`s:${j}`}>{text}</span>)}
            {cell.rec.map((text, j) => <span className={`bp-gantt-item is-rec is-${lane.id}`} key={`r:${j}`}>{text}</span>)}
          </div>),
        ])}
      </div>
    </section>
  );
}
