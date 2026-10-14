import { addDays, weekStart, type Actual, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { actualDate, actualUnits, matchesActual } from "../../SERVICES/planning/dailyPlanner";
import { pendingPackagingDecisions, type PackagingSource } from "../../SERVICES/planning/packagingActuals";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

type GanttItem = {
  text: string;
  id?: string;
  tank: string;
  style: string;
  type: string;
  quantity: number;
  actual?: boolean;
};

const names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"];

export default function PlanningWeekGantt({
  settings,
  plans,
  tanks,
  actuals,
  sources,
  week,
  onAssignPackagingToDate,
  onReturnPackagingToWaiting,
  selectedPackagingId,
  onSelectPackaging,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  actuals: Actual[];
  sources: PackagingSource[];
  week: string;
  onAssignPackagingToDate?: (date: string) => void;
  onReturnPackagingToWaiting?: () => void;
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
    const specialStyle = x.nonInventoryStyle;
    const specialType = x.nonInventoryType;
    const label = specialStyle && specialType
      ? `${displayStyle(specialStyle)} · ${specialType === "crates" ? "ארגזים" : "חביות"}`
      : productName(x.productId);
    return {
      id: x.id,
      text: `${label} · מיכל ${tankNumber(x.tankId, x.tankNumber)}`,
      tank: String(tankNumber(x.tankId, x.tankNumber)),
      style: specialStyle ? displayStyle(specialStyle) : (p ? displayStyle(p.style) : x.productId),
      type: specialType === "crates" || p?.type === "crates" ? "ארגזים" : "חביות",
      quantity: Math.round(x.quantity),
    };
  };

  const pending = current ? pendingPackagingDecisions(current, settings.products, actuals, sources) : [];
  const undated = pending.filter((x) => !x.date).map(itemFor);
  const executed = actuals.flatMap((actual) => {
    const date = actualDate(actual);
    if (!date || weekStart(date) !== week || Number(actual.quantity) <= 0) return [];
    const product = settings.products.find((item) => matchesActual(item, actual));
    const type = product?.type ?? (actual.packagingType === "bottles" ? "crates" : "kegs");
    return [{
      date,
      item: {
        text: "בוצע בפועל",
        tank: String(actual.tankNumber ?? "?"),
        style: displayStyle(product?.style ?? actual.beerStyle ?? ""),
        type: type === "crates" ? "ארגזים" : "חביות",
        quantity: Math.round(product ? actualUnits(product, actual) : Number(actual.quantity)),
        actual: true,
      } as GanttItem,
    }];
  });
  const cells = dates.map((date) => ({
    saved: pending.filter((x) => x.date === date).map(itemFor),
    actual: executed.filter((entry) => entry.date === date).map((entry) => entry.item),
  }));

  function clickDay(date: string) {
    if (!selectedPackagingId || !onAssignPackagingToDate) return;
    onAssignPackagingToDate(date);
  }

  const card = (item: GanttItem, compact = false) => item.actual ? (
    <span className={`bp-packaging-card is-actual ${compact ? "is-compact" : ""}`} aria-label={`בוצע בפועל: ${item.style}, מיכל ${item.tank}, ${item.quantity} ${item.type}`}>
      <b>מיכל {item.tank}</b><span>{item.style}</span>
      <small>{item.type} · {item.quantity} · בוצע בפועל</small>
    </span>
  ) : item.id ? (
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
        <p className="bp-muted">ביצועים שכבר דווחו מוצגים ביום הביצוע ואינם ניתנים להזזה. בחר אריזה שנותרה לביצוע כדי לשבץ או להחליף יום.</p>
      </div></div>

      <div
        className={`bp-packaging-waiting-lane ${selectedPackagingId ? "is-drop-target" : ""}`}
        role={selectedPackagingId ? "button" : undefined}
        tabIndex={selectedPackagingId ? 0 : undefined}
        onClick={() => { if (selectedPackagingId) onReturnPackagingToWaiting?.(); }}
        onKeyDown={(event) => {
          if (!selectedPackagingId || !onReturnPackagingToWaiting) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onReturnPackagingToWaiting();
          }
        }}
      >
        <div className="bp-packaging-waiting-heading">
          <b>ממתינות לשיבוץ</b>
          <span className="bp-count-badge">{undated.length}</span>
          {selectedPackagingId && <small>אריזה נבחרה — לחץ כאן כדי להחזיר לממתינות, או לחץ על יום לשיבוץ</small>}
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
              {cell.actual.map((item, j) => <span key={`actual:${dates[i]}:${j}`}>{card(item, true)}</span>)}
              {cell.saved.map((item, j) => <span key={item.id ?? `${dates[i]}:${j}`}>{card(item, true)}</span>)}
            </div>
            {!cell.saved.length && !cell.actual.length && <span className="bp-gantt-empty">+</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
