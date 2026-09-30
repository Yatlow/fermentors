import { useMemo } from "react";
import { runtimeConfig } from "../../config/runtimeConfig";
import { buildPlanningTimelineV2 } from "../../SERVICES/planning/planningTimelineV2";
import { tankReleases } from "../../SERVICES/planning/productionCycle";
import type { Actual, Settings, Tank, TankInput, WeekPlan } from "../../SERVICES/planning/planningEngine";

export default function PlanningShadowV2({ settings, plans, tanks, sources, actuals, today }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; sources: TankInput[]; actuals: Actual[]; today: string;
}) {
  const comparison = useMemo(() => {
    const timeline = buildPlanningTimelineV2({ today, settings, plans, tanks, sources, actuals });
    const v1 = tankReleases(sources, tanks, plans, settings, actuals, today);
    const v1ByTank = new Map(v1.map((release) => [release.tankId, release.date]));
    const v2ByTank = new Map(timeline.availability.map((release) => [release.tankId, release.date]));
    const rows = sources.filter((source) => Number(source.tankNumber) !== 1).map((source) => {
      const occupancy = timeline.occupancies
        .filter((item) => item.tankId === source.id)
        .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
      const v2Date = v2ByTank.get(source.id);
      const v1Date = v1ByTank.get(source.id);
      return { tank: String(source.tankNumber ?? source.id), v1Date, v2Date, same: (v1Date ?? "") === (v2Date ?? ""), occupancy };
    }).sort((a, b) => Number(a.tank) - Number(b.tank));
    return { timeline, rows, differences: rows.filter((row) => !row.same).length };
  }, [settings, plans, tanks, sources, actuals, today]);

  if (runtimeConfig.deployEnv === "production") return null;

  return <section className="bp-card" aria-label="Planning V2 Shadow">
    <h2>Planning V2 · Shadow</h2>
    <p className="bp-muted">קריאה בלבד · לא כותב ל-Firestore ולא משנה את התכנון.</p>
    <p><b>{comparison.rows.length - comparison.differences}</b> מיכלים תואמים · <b>{comparison.differences}</b> הבדלים · <b>{comparison.timeline.issues.length}</b> התנגשויות V2</p>
    {comparison.timeline.issues.length > 0 && <details open>
      <summary>התנגשויות שמצא V2</summary>
      {comparison.timeline.issues.map((issue, index) => <div key={index}>⚠ {issue.message}</div>)}
    </details>}
    <details>
      <summary>השוואת שחרור מיכלים V1 ↔ V2</summary>
      <div className="bp-table-wrap"><table className="bp-table">
        <thead><tr><th>מיכל</th><th>V1</th><th>V2</th><th>מצב</th></tr></thead>
        <tbody>{comparison.rows.map((row) => <tr key={row.tank}>
          <td>{row.tank}</td><td>{row.v1Date ?? "—"}</td><td>{row.v2Date ?? "—"}</td><td>{row.same ? "✓" : "⚠"}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
    <details>
      <summary>Timeline ({comparison.timeline.occupancies.length} occupancies)</summary>
      {comparison.timeline.occupancies.map((item) => <div key={item.id}>
        <b>מיכל {item.tankNumber}</b> · {item.source === "actual" ? "בפועל" : "מתוכנן"} · {item.style}
        {item.batchNumber ? ` · #${item.batchNumber}` : ""} · {item.startsAt} → {item.expectedEmptyAt ?? "לא ידוע"}
      </div>)}
    </details>
  </section>;
}
