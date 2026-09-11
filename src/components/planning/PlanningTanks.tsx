import type { Fermentor } from "../../App";
import {
  addDays,
  sameStyle,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { tankReleases } from "../../SERVICES/planning/productionCycle";
import type { Actual } from "../../SERVICES/planning/planningEngine";

export default function PlanningTanks({
  tanks,
  sources,
  plans,
  settings,
  actuals,
  today,
}: {
  tanks: Tank[];
  sources: Fermentor[];
  plans: WeekPlan[];
  settings: Settings;
  actuals: Actual[];
  today: string;
}) {
  const releases = tankReleases(sources, tanks, plans, settings, actuals, today);
  const brews = plans.flatMap((w) => w.brews).filter((b) => b.date >= today);
  const rows = sources
    .filter((s) => Number(s.tankNumber) !== 1)
    .map((source) => {
      const tank = tanks.find((t) => t.id === source.id);
      const release = releases.find((r) => r.tankId === source.id);
      const next = brews
        .filter((b) => b.tankId === source.id)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      const plannedEmpty = plans
        .flatMap((w) => w.packaging)
        .filter((p) => p.tankId === source.id && p.date && p.date >= today)
        .sort((a, b) => a.date!.localeCompare(b.date!))
        .at(-1)?.date;
      return { source, tank, release, next, plannedEmpty };
    })
    .sort((a, b) => Number(a.source.tankNumber) - Number(b.source.tankNumber));

  return (
    <section>
      <div className="bp-section-heading">
        <div>
          <h2>מיכלים ותזמון</h2>
          <p className="bp-muted">תמונת מצב אחת של המילוי הנוכחי, הריקון והבישול הבא.</p>
        </div>
      </div>
      <div className="bp-table-scroll">
        <table className="bp-stock-table bp-tank-table">
          <thead>
            <tr>
              <th>מיכל</th>
              <th>תכולה נוכחית</th>
              <th>מילוי נוכחי</th>
              <th>הבשלה</th>
              <th>ריקון</th>
              <th>זמין לבישול</th>
              <th>בישול הבא</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ source, tank, release, next, plannedEmpty }) => (
              <tr key={source.id}>
                <th>#{source.tankNumber}</th>
                <td>
                  {tank ? `${tank.style} · אצווה ${tank.batch}` : Number(source.action) === 0 ? "מחכה לבישול" : "—"}
                </td>
                <td>{tank?.brewed ? shortDate(tank.brewed) : "—"}</td>
                <td>{tank?.ready ? shortDate(tank.ready) : "—"}</td>
                <td>
                  {plannedEmpty ? (
                    <><strong>{shortDate(plannedEmpty)}</strong><small className="bp-status"> נקבע</small></>
                  ) : release?.emptyDate ? shortDate(release.emptyDate) : "טרם נקבע"}
                </td>
                <td>{release?.date ? shortDate(release.date) : "תלוי בריקון"}</td>
                <td>
                  {next ? (
                    <><strong>{next.style}</strong> · {shortDate(next.date)}</>
                  ) : release?.date && release.date <= addDays(today, 84) ? "פנוי לשיבוץ" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
