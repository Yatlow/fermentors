import type { Fermentor } from "../../App";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  type Settings,
  type Tank,
  type WeekPlan,
  type Actual,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import { tankReleases } from "../../SERVICES/planning/productionCycle";

const tankType = (value: unknown) => {
  const n = Number(value);
  if (n >= 2 && n <= 4) return "בודד";
  if (n >= 5 && n <= 8) return "כפול";
  if (n >= 9) return "משולש";
  return "—";
};

function forecastDateUndatedPackaging(plans: WeekPlan[]) {
  return plans.map((w) => ({
    ...w,
    packaging: w.packaging.map((r) => r.date ? r : { ...r, date: addDays(w.id, 4) }),
  }));
}

export default function PlanningTanks({ tanks, sources, plans, settings, actuals, today }: {
  tanks: Tank[];
  sources: Fermentor[];
  plans: WeekPlan[];
  settings: Settings;
  actuals: Actual[];
  today: string;
}) {
  const forecastPlans = forecastDateUndatedPackaging(plans);
  const releases = tankReleases(sources, tanks, forecastPlans, settings, actuals, today);
  const assignedBrews = plans
    .flatMap((w) => w.brews)
    .filter((b) => !!b.tankId && b.date >= today);

  const rows = sources
    .filter((s) => Number(s.tankNumber) !== 1)
    .map((source) => {
      const tank = tanks.find((t) => t.id === source.id);
      const release = releases.find((r) => r.tankId === source.id);
      const next = assignedBrews
        .filter((b) => b.tankId === source.id)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      const originalEmptyPlan = plans
        .flatMap((w) => w.packaging.map((p) => ({ ...p, week: w.id })))
        .filter((p) => p.tankId === source.id && p.quantity > 0)
        .sort((a, b) => (a.date ?? addDays(a.week, 4)).localeCompare(b.date ?? addDays(b.week, 4)))
        .at(-1);
      const plannedEmpty = release?.emptyDate ?? null;
      const emptyWasUndated = !!originalEmptyPlan && !originalEmptyPlan.date && plannedEmpty === addDays(originalEmptyPlan.week, 4);
      return { source, tank, release, next, plannedEmpty, emptyWasUndated };
    })
    .sort((a, b) => Number(a.source.tankNumber) - Number(b.source.tankNumber));

  return (
    <section>
      <div className="bp-section-heading"><div>
        <h2>מיכלים ותזמון</h2>
        <p className="bp-muted">ריקון מתוכנן משחרר מיכל; שיבוץ בישול תופס אותו בחזרה. אריזה ללא יום מקבלת כאן תחזית חמישי בלבד עד שמנהל העבודה משבץ יום.</p>
      </div></div>
      <div className="bp-table-scroll">
        <table className="bp-stock-table bp-tank-table">
          <thead><tr><th>מיכל</th><th>סוג</th><th>תכולה נוכחית</th><th>מילוי נוכחי</th><th>הבשלה</th><th>ריקון</th><th>סטטוס לשיבוץ</th><th>בישול הבא</th></tr></thead>
          <tbody>{rows.map(({ source, tank, release, next, plannedEmpty, emptyWasUndated }) => (
            <tr key={source.id}>
              <th>#{source.tankNumber}</th>
              <td><b>{tankType(source.tankNumber)}</b></td>
              <td>{tank ? <><span className={`bp-tank-style ${beerStyleClass(tank.style).className}`}>{displayStyle(tank.style)}</span> · אצווה {tank.batch}</> : Number(source.action) === 0 ? <span className="bp-ready-chip">מחכה לבישול</span> : "—"}</td>
              <td>{tank?.brewed ? shortDate(tank.brewed) : "—"}</td>
              <td>{tank?.ready ? shortDate(tank.ready) : "—"}</td>
              <td>{plannedEmpty ? <><strong>{shortDate(plannedEmpty)}</strong><small className="bp-status"> {emptyWasUndated ? "תחזית עד שיבוץ יום" : "נקבע"}</small></> : "טרם נקבע"}</td>
              <td>{next ? <span className="bp-warning-chip">שמור לבישול {shortDate(next.date)}</span> : release?.date ? <span className="bp-ready-chip">פנוי מ־{shortDate(release.date)}</span> : "תלוי בריקון"}</td>
              <td>{next ? <><strong>{displayStyle(next.style)}</strong> · {shortDate(next.date)}</> : release?.date && release.date <= addDays(today, 84) ? <span className="bp-ready-chip">פנוי לשיבוץ</span> : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}
