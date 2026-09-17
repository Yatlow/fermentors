import { Fragment, useMemo, useState } from "react";
import {
  addDays,
  weekNumber,
  weekStart,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";

const ROWS = [
  { id: "deliveries", label: "משלוחים" },
  { id: "packaging", label: "אריזות" },
  { id: "brews", label: "בישולים" },
] as const;

type RowId = (typeof ROWS)[number]["id"];
type ViewMode = "summary" | "calendar";

type CompactItem = {
  key: string;
  title: string;
  meta: string;
  pending?: boolean;
};

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

export default function PlanningFiveWeekOverview({
  settings,
  plans,
  tanks,
  today,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  today: string;
}) {
  const [view, setView] = useState<ViewMode>("summary");
  const currentWeek = weekStart(today);
  const weekIds = useMemo(
    () => Array.from({ length: 5 }, (_, index) => addDays(currentWeek, (index - 1) * 7)),
    [currentWeek],
  );
  const nextPlanningWeek = addDays(currentWeek, 7);
  const rangeStart = weekIds[0];
  const calendarDays = useMemo(
    () => Array.from({ length: 35 }, (_, index) => addDays(rangeStart, index)),
    [rangeStart],
  );

  const productFor = (id: string) => settings.products.find((product) => product.id === id);
  const tankNumber = (tankId?: string, fallback?: string | number) =>
    tanks.find((tank) => tank.id === tankId)?.number ?? fallback ?? "?";

  function itemsFor(row: RowId, weekId: string): CompactItem[] {
    const plan = plans.find((item) => item.id === weekId);
    if (!plan) return [];

    if (row === "deliveries") {
      const grouped = new Map<string, { title: string; quantity: number }>();
      for (const delivery of plan.deliveries ?? []) {
        const product = productFor(delivery.productId);
        const title = product
          ? `${displayStyle(product.style)} · ${product.type === "crates" ? "ארגזים" : "חביות"}`
          : delivery.productId;
        const current = grouped.get(delivery.productId) ?? { title, quantity: 0 };
        current.quantity += delivery.quantity;
        grouped.set(delivery.productId, current);
      }
      return Array.from(grouped.entries()).map(([productId, item]) => ({
        key: productId,
        title: item.title,
        meta: String(Math.round(item.quantity)),
      }));
    }

    if (row === "packaging") {
      const grouped = new Map<string, { title: string; quantity: number; pending: number; days: Set<string> }>();
      for (const run of plan.packaging.filter((item) => item.quantity > 0)) {
        const product = productFor(run.productId);
        const title = product
          ? `${displayStyle(product.style)} · ${product.type === "crates" ? "ארגזים" : "חביות"}`
          : run.productId;
        const current = grouped.get(run.productId) ?? { title, quantity: 0, pending: 0, days: new Set<string>() };
        current.quantity += run.quantity;
        if (run.date) current.days.add(run.date);
        else current.pending += 1;
        grouped.set(run.productId, current);
      }
      return Array.from(grouped.entries()).map(([productId, item]) => ({
        key: productId,
        title: item.title,
        meta: `${Math.round(item.quantity)}${item.days.size ? ` · ${item.days.size} ימי אריזה` : ""}`,
        pending: item.pending > 0,
      }));
    }

    const grouped = new Map<string, { count: number; pending: number }>();
    for (const brew of plan.brews) {
      const key = displayStyle(brew.style);
      const current = grouped.get(key) ?? { count: 0, pending: 0 };
      current.count += 1;
      if (!brew.tankId) current.pending += 1;
      grouped.set(key, current);
    }
    return Array.from(grouped.entries()).map(([style, item]) => ({
      key: style,
      title: style,
      meta: item.count === 1 ? "בישול 1" : `${item.count} בישולים`,
      pending: item.pending > 0,
    }));
  }

  function calendarEvents(date: string): Array<{ key: string; label: string; type: RowId; pending?: boolean }> {
    const weekId = weekStart(date);
    const plan = plans.find((item) => item.id === weekId);
    if (!plan) return [];
    const events: Array<{ key: string; label: string; type: RowId; pending?: boolean }> = [];

    for (const delivery of plan.deliveries ?? []) {
      if (delivery.dispatchDate !== date) continue;
      const product = productFor(delivery.productId);
      const label = product
        ? `משלוח · ${displayStyle(product.style)} ${Math.round(delivery.quantity)} ${product.type === "crates" ? "ארגז׳" : "חב׳"}`
        : `משלוח · ${delivery.productId}`;
      events.push({ key: `d:${delivery.id}`, label, type: "deliveries" });
    }

    for (const run of plan.packaging) {
      if (run.quantity <= 0 || run.date !== date) continue;
      const product = productFor(run.productId);
      const label = product
        ? `אריזה · ${displayStyle(product.style)} ${Math.round(run.quantity)} ${product.type === "crates" ? "ארג׳" : "חב׳"}`
        : `אריזה · ${run.productId}`;
      events.push({ key: `p:${run.id ?? `${run.productId}:${run.tankId}:${date}`}`, label, type: "packaging" });
    }

    for (const brew of plan.brews) {
      if (brew.date !== date) continue;
      events.push({
        key: `b:${brew.id}`,
        label: `בישול · ${displayStyle(brew.style)}${brew.tankId ? ` · מ׳ ${tankNumber(brew.tankId)}` : ""}`,
        type: "brews",
        pending: !brew.tankId,
      });
    }

    return events;
  }

  return (
    <section className="bp-five-week-overview">
      <div className="bp-section-heading bp-five-week-heading">
        <div>
          <h2>מבט 5 שבועות</h2>
          <p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה.</p>
        </div>
        <div className="bp-five-week-toggle" role="group" aria-label="אופן תצוגה">
          <button type="button" aria-pressed={view === "summary"} onClick={() => setView("summary")}>סיכום שבועי</button>
          <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>לוח 5 שבועות</button>
        </div>
      </div>

      {view === "summary" ? (
        <div className="bp-five-week-scroll">
          <div className="bp-five-week-grid" role="table" aria-label="תכנון לחמישה שבועות">
            <div className="bp-five-week-corner" />
            {weekIds.map((weekId) => (
              <div
                key={`head:${weekId}`}
                className={`bp-five-week-head ${weekId === currentWeek ? "is-current" : ""} ${weekId === nextPlanningWeek ? "is-next" : ""}`}
              >
                <b>שבוע {weekNumber(weekId)}</b>
                <span>{shortDate(weekId)}–{shortDate(addDays(weekId, 6))}</span>
                {weekId === currentWeek && <small>השבוע</small>}
                {weekId === nextPlanningWeek && <small>שבוע התכנון הבא</small>}
              </div>
            ))}

            {ROWS.map((row) => (
              <Fragment key={row.id}>
                <div className={`bp-five-week-row-label is-${row.id}`}>{row.label}</div>
                {weekIds.map((weekId) => {
                  const items = itemsFor(row.id, weekId);
                  return (
                    <div className={`bp-five-week-cell is-${row.id}`} key={`${row.id}:${weekId}`}>
                      {items.map((item) => (
                        <article className={`bp-five-week-item ${item.pending ? "is-pending" : ""}`} key={item.key}>
                          <b>{item.title}</b>
                          <small>{item.meta}</small>
                          {item.pending && <span>ממתין לשיבוץ</span>}
                        </article>
                      ))}
                      {!items.length && <span className="bp-five-week-empty">—</span>}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <div className="bp-month-scroll">
          <div className="bp-month-calendar" role="grid" aria-label="לוח תכנון לחמישה שבועות">
            {DAY_NAMES.map((name) => <div className="bp-month-day-name" key={name}>{name}</div>)}
            {calendarDays.map((date) => {
              const events = calendarEvents(date);
              const weekId = weekStart(date);
              const dayNumber = Number(date.slice(8, 10));
              return (
                <div
                  className={`bp-month-day ${date === today ? "is-today" : ""} ${weekId === currentWeek ? "is-current-week" : ""} ${weekId === nextPlanningWeek ? "is-next-week" : ""}`}
                  key={date}
                >
                  <div className="bp-month-date"><b>{dayNumber}</b><small>{shortDate(date)}</small></div>
                  <div className="bp-month-events">
                    {events.map((event) => (
                      <span className={`bp-month-event is-${event.type} ${event.pending ? "is-pending" : ""}`} key={event.key}>{event.label}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
