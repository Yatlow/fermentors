import { addDays, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

type GanttItem = {
  text: string;
  id?: string;
  tank: string;
  style: string;
  type: string;
  quantity: number;
};

const names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"];

export default function PlanningWeekGantt({
  settings,
  plans,
  tanks,
  week,
  onSelectDate,
  onAssignPackagingToDate,
  selectedPackagingId,
  onSelectPackaging,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  week: string;
  onSelectDate: (date: string) => void;
  onAssignPackagingToDate?: (date: string) => void;
  selectedPackagingId?: string | null;
  onSelectPackaging?: (id: string) => void;
}) {
  const current = plans.find((w) => w.id === week);
  const dates = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const product = (id: string) => settings.products.find((x) => x.id === id);
  const productName = (id: string) => {
    const p = product(id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };
  const tankNumber = (tankId?: string, fallback?: string | number) => tanks.find((t) => t.id === tankId)?.number ?? fallback ?? "?";
  const itemFor = (x: NonNullable<typeof current>["packaging"][number]): GanttItem => {
    const p = product(x.productId);
    return {
      id: x.id,
      text: `${productName(x.productId)} · מיכל ${tankNumber(x.tankId, x.tankNumber)}`,
      tank: String(tankNumber(x.tankId, x.tankNumber)),
      style: p ? displayStyle(p.style) : x.productId,
      type: p?.type === "crates" ? "ארגזים" : "חביות",
      quantity: Math.round(x.quantity),
    };
  };

  const undated = (current?.packaging ?? []).filter((x) => !x.date && x.quantity > 0).map(itemFor);
  const cells = dates.map((date) => ({
    saved: (current?.packaging ?? []).filter((x) => x.date === date).map(itemFor),
  }));

  function clickDay(date: string) {
    if (selectedPackagingId && onAssignPackagingToDate) {
      onAssignPackagingToDate(date);
      return;
    }
    onSelectDate(date);
  }

  const card = (item: GanttItem, compact = false) => item.id ? (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={selectedPackagingId === item.id}
      className={`bp-packaging-card ${compact ? "is-compact" : ""} ${selectedPackagingId === item.id ? "is-selected" : ""}`}
      onClick={(event) => { event.stopPropagation(); onSelectPackaging?.(item.id!); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onSelectPackaging?.(item.id!);
        }
      }}
    >
      <b>מיכל {item.tank}</b>
      <span>{item.style}</span>
      <small>{item.type} · {item.quantity}</small>
    </span>
  ) : (
    <span className={`bp-packaging-card ${compact ? "is-compact" : ""}`}>
      <b>מיכל {item.tank}</b><span>{item.style}</span><small>{item.type} · {item.quantity}</small>
    </span>
  );

  return (
    <section className="bp-gantt-section">
      <div className="bp-section-heading"><div>
        <h3>שיבוץ אריזות לימים</h3>
        <p className="bp-muted">בחר אריזה מאזור ההמתנה ואז לחץ על יום. אפשר לבחור שתי אריזות שכבר שובצו כדי להחליף ביניהן ימים.</p>
      </div></div>

      <div className="bp-packaging-waiting-lane">
        <div className="bp-packaging-waiting-heading">
          <b>ממתינות לשיבוץ</b>
          <span className="bp-count-badge">{undated.length}</span>
          {selectedPackagingId && <small>אריזה נבחרה — לחץ על היום הרצוי</small>}
        </div>
        <div className="bp-packaging-waiting-row">
          {undated.length ? undated.map((item) => <span key={item.id ?? item.text}>{card(item)}</span>) : <small className="bp-muted">כל האריזות שובצו לימים.</small>}
        </div>
      </div>

      <div className="bp-gantt bp-gantt-packaging-only" role="table" aria-label="שיבוץ אריזות שבועי">
        <div className="bp-gantt-head" />
        {dates.map((date, i) => (
          <button type="button" className={`bp-gantt-head bp-gantt-day-button ${selectedPackagingId ? "is-drop-target" : ""}`} key={date} onClick={() => clickDay(date)}>
            {names[i]}<small>{shortDate(date)}</small>
          </button>
        ))}
        <div className="bp-gantt-label is-packaging">אריזה</div>
        {cells.map((cell, i) => (
          <button type="button" className={`bp-gantt-cell bp-gantt-cell-button ${selectedPackagingId ? "is-drop-target" : ""}`} key={dates[i]} onClick={() => clickDay(dates[i])}>
            <div className="bp-gantt-packaging-cards">
              {cell.saved.map((item, j) => <span key={item.id ?? `${dates[i]}:${j}`}>{card(item, true)}</span>)}
            </div>
            {!cell.saved.length && <span className="bp-gantt-empty">+</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
