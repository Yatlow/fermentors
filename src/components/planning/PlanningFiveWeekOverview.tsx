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

function dayLabel(date?: string) {
  if (!date) return "טרם שובץ";
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const names = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
  return `${names[day]} · ${shortDate(date)}`;
}

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
  const currentWeek = weekStart(today);
  const weekIds = Array.from({ length: 5 }, (_, index) => addDays(currentWeek, (index - 1) * 7));
  const nextPlanningWeek = addDays(currentWeek, 7);

  const productFor = (id: string) => settings.products.find((product) => product.id === id);
  const tankNumber = (tankId?: string, fallback?: string | number) =>
    tanks.find((tank) => tank.id === tankId)?.number ?? fallback ?? "?";

  function itemsFor(row: RowId, weekId: string) {
    const plan = plans.find((item) => item.id === weekId);
    if (!plan) return [];

    if (row === "deliveries") {
      return (plan.deliveries ?? []).map((delivery) => {
        const product = productFor(delivery.productId);
        return {
          key: delivery.id,
          title: product ? `${displayStyle(product.style)} · ${product.type === "crates" ? "ארגזים" : "חביות"}` : delivery.productId,
          meta: `${Math.round(delivery.quantity)} · ${dayLabel(delivery.dispatchDate)}`,
          pending: false,
        };
      });
    }

    if (row === "packaging") {
      return plan.packaging
        .filter((run) => run.quantity > 0)
        .map((run, index) => {
          const product = productFor(run.productId);
          return {
            key: run.id ?? `${run.productId}:${index}`,
            title: product ? `${displayStyle(product.style)} · ${product.type === "crates" ? "ארגזים" : "חביות"}` : run.productId,
            meta: `מיכל ${tankNumber(run.tankId, run.tankNumber)} · ${Math.round(run.quantity)} · ${dayLabel(run.date)}`,
            pending: !run.date,
          };
        });
    }

    return plan.brews.map((brew) => ({
      key: brew.id,
      title: displayStyle(brew.style),
      meta: `${brew.tankId ? `מיכל ${tankNumber(brew.tankId)}` : "ללא מיכל"} · ${dayLabel(brew.date)}`,
      pending: !brew.tankId,
    }));
  }

  return (
    <section className="bp-five-week-overview">
      <div className="bp-section-heading">
        <div>
          <h2>מבט 5 שבועות</h2>
          <p className="bp-muted">שבוע קודם, השבוע הנוכחי ושלושה שבועות קדימה. כרגע זו תצוגת תכנון בלבד, ללא חיבור ליומן.</p>
        </div>
      </div>

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
            <>
              <div className={`bp-five-week-row-label is-${row.id}`} key={`label:${row.id}`}>{row.label}</div>
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
            </>
          ))}
        </div>
      </div>
    </section>
  );
}
