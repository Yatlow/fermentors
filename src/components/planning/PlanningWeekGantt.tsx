import { useMemo } from "react";
import { addDays, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import type { planningWorkspace } from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
type GanttItem = { text: string; id?: string };
type GanttCell = { saved: GanttItem[]; rec: GanttItem[] };
type GanttLane = { id: "delivery" | "packaging" | "brew"; label: string; cells: GanttCell[] };
const names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"];

export default function PlanningWeekGantt({ settings, plans, tanks, workspace, week, onSelectDate, selectedPackagingId, onSelectPackaging }: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  workspace: Workspace;
  week: string;
  onSelectDate: (date: string) => void;
  selectedPackagingId?: string | null;
  onSelectPackaging?: (id: string) => void;
}) {
  const current = plans.find((w) => w.id === week);
  const recommendations = useMemo(() => workspace.actions.filter((a) => a.date >= week && a.date <= addDays(week, 6)), [workspace.actions, week]);
  const dates = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const productName = (id: string) => {
    const p = settings.products.find((x) => x.id === id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };
  const lanes: GanttLane[] = [
    { id: "delivery", label: "משלוח", cells: dates.map((date) => ({ saved: (current?.deliveries ?? []).filter((x) => x.dispatchDate === date).map((x) => ({ text: productName(x.productId) })), rec: recommendations.filter((x) => x.kind === "delivery" && x.date === date).map((x) => ({ text: x.kind === "delivery" ? productName(x.productId) : "" })) })) },
    { id: "packaging", label: "אריזה", cells: dates.map((date) => ({ saved: (current?.packaging ?? []).filter((x) => x.date === date).map((x) => ({ id: x.id, text: `${productName(x.productId)} · מיכל ${tanks.find((t) => t.id === x.tankId)?.number ?? x.tankNumber ?? "?"}` })), rec: recommendations.filter((x) => x.kind === "packaging" && x.date === date).map((x) => ({ text: x.kind === "packaging" ? `${productName(x.productId)} · מיכל ${x.allocations[0]?.number ?? "?"}` : "" })) })) },
    { id: "brew", label: "בישול", cells: dates.map((date) => ({ saved: (current?.brews ?? []).filter((x) => x.date === date).map((x) => ({ text: `${displayStyle(x.style)} · ${x.tankId ? `מיכל ${tanks.find((t) => t.id === x.tankId)?.number ?? x.tankId}` : "טרם שובץ"}` })), rec: recommendations.filter((x) => x.kind === "brew" && x.date === date).map((x) => ({ text: x.kind === "brew" ? `${displayStyle(x.style)} · המלצה` : "" })) })) },
  ];

  return (
    <section className="bp-gantt-section">
      <div className="bp-section-heading"><div><h3>שיבוץ לימים</h3><p className="bp-muted">מלא = החלטה ליישום · מקווקו = המלצה לידיעה. להחלפת ימי אריזה: לחץ על אריזה אחת ואז על אריזה שנייה.</p></div></div>
      <div className="bp-gantt" role="table" aria-label="גאנט שבועי">
        <div className="bp-gantt-head" />
        {dates.map((date, i) => <button type="button" className="bp-gantt-head bp-gantt-day-button" key={date} onClick={() => onSelectDate(date)}>{names[i]}<small>{shortDate(date)}</small></button>)}
        {lanes.flatMap((lane) => [
          <div className={`bp-gantt-label is-${lane.id}`} key={`${lane.id}:label`}>{lane.label}</div>,
          ...lane.cells.map((cell, i) => <button type="button" className="bp-gantt-cell bp-gantt-cell-button" key={`${lane.id}:${dates[i]}`} onClick={() => onSelectDate(dates[i])}>
            {cell.saved.map((item, j) => lane.id === "packaging" && item.id ? <span role="button" tabIndex={0} aria-pressed={selectedPackagingId === item.id} className={`bp-gantt-item is-saved is-packaging ${selectedPackagingId === item.id ? "is-selected" : ""}`} key={`s:${j}`} onClick={(e) => { e.stopPropagation(); onSelectPackaging?.(item.id!); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelectPackaging?.(item.id!); } }}>{item.text}</span> : <span className={`bp-gantt-item is-saved is-${lane.id}`} key={`s:${j}`}>{item.text}</span>)}
            {cell.rec.map((item, j) => <span className={`bp-gantt-item is-rec is-${lane.id}`} key={`r:${j}`}>{item.text}</span>)}
            {!cell.saved.length && !cell.rec.length && <span className="bp-gantt-empty">+</span>}
          </button>),
        ])}
      </div>
    </section>
  );
}
