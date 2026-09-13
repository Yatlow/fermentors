import { addDays, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

type GanttItem = { text: string; id?: string };
const names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"];

export default function PlanningWeekGantt({ settings, plans, tanks, week, onSelectDate, selectedPackagingId, onSelectPackaging }: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  week: string;
  onSelectDate: (date: string) => void;
  selectedPackagingId?: string | null;
  onSelectPackaging?: (id: string) => void;
}) {
  const current = plans.find((w) => w.id === week);
  const dates = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const productName = (id: string) => {
    const p = settings.products.find((x) => x.id === id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };
  const undated = (current?.packaging ?? []).filter((x) => !x.date && x.quantity > 0);
  const cells = dates.map((date) => ({
    saved: (current?.packaging ?? [])
      .filter((x) => x.date === date)
      .map((x): GanttItem => ({
        id: x.id,
        text: `${productName(x.productId)} · מיכל ${tanks.find((t) => t.id === x.tankId)?.number ?? x.tankNumber ?? "?"}`,
      })),
  }));

  return (
    <section className="bp-gantt-section">
      <div className="bp-section-heading"><div>
        <h3>שיבוץ אריזות לימים</h3>
        <p className="bp-muted">הטבלה היומית מיועדת לאריזות בלבד. משלוח ובישולים נשארים בהחלטה שבועית ומנוהלים בכרטיסים שמעל.</p>
      </div></div>

      {undated.length > 0 && <div className="bp-alert">
        <b>{undated.length} אריזות עדיין לא שובצו ליום:</b>{" "}
        {undated.map((x) => `${productName(x.productId)} · מיכל ${tanks.find((t) => t.id === x.tankId)?.number ?? x.tankNumber ?? "?"}`).join(" · ")}
      </div>}

      <div className="bp-gantt bp-gantt-packaging-only" role="table" aria-label="שיבוץ אריזות שבועי">
        <div className="bp-gantt-head" />
        {dates.map((date, i) => <button type="button" className="bp-gantt-head bp-gantt-day-button" key={date} onClick={() => onSelectDate(date)}>{names[i]}<small>{shortDate(date)}</small></button>)}
        <div className="bp-gantt-label is-packaging">אריזה</div>
        {cells.map((cell, i) => <button type="button" className="bp-gantt-cell bp-gantt-cell-button" key={dates[i]} onClick={() => onSelectDate(dates[i])}>
          {cell.saved.map((item, j) => item.id ? <span role="button" tabIndex={0} aria-pressed={selectedPackagingId === item.id} className={`bp-gantt-item is-saved is-packaging ${selectedPackagingId === item.id ? "is-selected" : ""}`} key={`s:${j}`} onClick={(e) => { e.stopPropagation(); onSelectPackaging?.(item.id!); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelectPackaging?.(item.id!); } }}>{item.text}</span> : <span className="bp-gantt-item is-saved is-packaging" key={`s:${j}`}>{item.text}</span>)}
          {!cell.saved.length && <span className="bp-gantt-empty">+</span>}
        </button>)}
      </div>
    </section>
  );
}
