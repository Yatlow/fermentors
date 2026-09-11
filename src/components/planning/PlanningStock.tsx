import { useState } from "react";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  tempoNow,
  weeklyDemand,
  addDays,
  num,
  type Settings,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import {
  groupKey,
  styleGroups,
} from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import type { PlanningAction } from "../../SERVICES/planning/workspace";
import type { ProductionNeed } from "../../SERVICES/planning/productionNeeds";

const fmt = (n: number) =>
  n.toLocaleString("he-IL", { maximumFractionDigits: 0 });
function Coverage({
  stock,
  daily,
  today,
}: {
  stock: number | null;
  daily: number;
  today: string;
}) {
  if (!daily) return <span>ללא צפי מכירות קבוע</span>;
  if (stock === null) return <span>מלאי טמפו טרם עודכן</span>;
  const days = Math.max(0, Math.floor(stock / daily));
  return (
    <div className="bp-coverage">
      <strong>
        {days
          ? [
              Math.floor(days / 7) ? `${Math.floor(days / 7)} שבועות` : "",
              days % 7 ? `${days % 7} ימים` : "",
            ]
              .filter(Boolean)
              .join(" ו־")
          : "פחות מיום"}
      </strong>
      <small>
        עד <bdi>{shortDate(addDays(today, days))}</bdi>
      </small>
    </div>
  );
}
export default function PlanningStock({
  settings,
  pallets,
  today,
  actions,
  plans,
  needs,
}: {
  settings: Settings;
  pallets: Pallet[];
  today: string;
  actions: PlanningAction[];
  plans: WeekPlan[];
  needs: ProductionNeed[];
}) {
  const [view, setView] = useState<"cards" | "table">("cards");
  const nextActions: {
    kind: string;
    date: string;
    group: string;
    description: string;
    status: string;
  }[] = [];
  const productAction = (
    kind: string,
    date: string,
    id: string,
    quantity: number,
    status: string,
  ) => {
    const p = settings.products.find((p) => p.id === id);
    if (p && date >= today && quantity > 0)
      nextActions.push({
        kind,
        date,
        group: groupKey(p.style),
        description: `${fmt(quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"}`,
        status,
      });
  };
  for (const w of plans) {
    w.packaging.forEach((r) =>
      productAction(
        "packaging",
        r.date ?? w.id,
        r.productId,
        r.quantity,
        "החלטה",
      ),
    );
    (w.deliveries ?? []).forEach((d) =>
      productAction(
        "delivery",
        d.dispatchDate,
        d.productId,
        d.quantity,
        d.id.startsWith("marked:") ? "מיועד · ממפת המקרר" : "החלטה",
      ),
    );
    w.brews
      .filter((b) => b.date >= today)
      .forEach((b) =>
        nextActions.push({
          kind: "brew",
          date: b.date,
          group: groupKey(b.style),
          description: `${fmt(b.liters)} ל׳`,
          status: "החלטה",
        }),
      );
  }
  for (const a of actions.filter((a) => a.date >= today)) {
    if (a.kind === "brew")
      nextActions.push({
        kind: a.kind,
        date: a.date,
        group: groupKey(a.style),
        description: `${fmt(a.liters)} ל׳`,
        status: "המלצה",
      });
    else productAction(a.kind, a.date, a.productId, a.quantity, "המלצה");
  }
  nextActions.sort((a, b) => a.date.localeCompare(b.date));
  for (const need of needs)
    nextActions.push({
      kind: need.kind,
      date: need.date,
      group: groupKey(need.style),
      description: `${fmt(need.quantity)} ${need.unit}`,
      status: "המלצה · נדרש פתרון",
    });
  nextActions.sort((a, b) => a.date.localeCompare(b.date));
  const groups = styleGroups(settings).filter(
    (g) => g.key === "special" || g.products.some((p) => p.monthly > 0),
  );
  const rows = groups.map((g) => ({
    ...g,
    formats: (["crates", "kegs"] as const).map((type) => {
      const p = g.products.find((p) => p.type === type);
      const brewery = pallets
        .filter(
          (p) =>
            p.zone !== "shipped" &&
            p.itemType === type &&
            groupKey(p.beerStyle) === g.key,
        )
        .reduce((sum, p) => sum + num(p.quantity), 0);
      return {
        type,
        label: type === "crates" ? "בקבוקים · ארגזי 24" : "חביות · 20 ל׳",
        brewery,
        tempo: p ? tempoNow(p, today) : null,
        daily: p ? weeklyDemand(p) / 7 : 0,
      };
    }),
  }));
  const upcoming = (key: string) => (
    <div className="bp-upcoming">
      {(
        [
          ["delivery", "המשלוח הבא"],
          ["packaging", "האריזה הבאה"],
          ["brew", "הבישול הבא"],
        ] as const
      ).map(([kind, label]) => {
        const next = nextActions.find(
          (a) => a.group === key && a.kind === kind,
        );
        const sameDay = nextActions.filter(
          (a) => a.group === key && a.kind === kind && a.date === next?.date,
        );
        return (
          <div key={kind}>
            <small>{label}</small>
            {next ? (
              <>
                <span>
                  <bdi>{shortDate(next.date)}</bdi>
                </span>
                {sameDay.map((a, i) => (
                  <span className="bp-next-detail" key={i}>
                    {a.description}{" "}
                    <small className="bp-status">{a.status}</small>
                  </span>
                ))}
              </>
            ) : (
              <span className="bp-muted">טרם שובץ</span>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <section>
      <div className="bp-section-heading">
        <h2>מלאי וכיסוי</h2>
        <div className="bp-actions" role="group" aria-label="תצוגת מלאי">
          <button
            aria-pressed={view === "cards"}
            onClick={() => setView("cards")}
          >
            כרטיסים
          </button>
          <button
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            טבלה
          </button>
        </div>
      </div>
      {view === "cards" ? (
        <div className="bp-stock-grid">
          {rows.map((g) => (
            <article className="bp-card" key={g.key}>
              <h3 className={beerStyleClass(g.style).className}>{g.style}</h3>
              <div className="bp-formats">
                {g.formats.map((f) => (
                  <div key={f.type}>
                    <h4>{f.label}</h4>
                    <p>
                      במבשלה: <strong>{fmt(f.brewery)}</strong>
                    </p>
                    <p>
                      טמפו, אומדן להיום:{" "}
                      <strong>{f.tempo === null ? "—" : fmt(f.tempo)}</strong>
                    </p>
                    <small>כיסוי טמפו</small>
                    <Coverage stock={f.tempo} daily={f.daily} today={today} />
                    <small>כיסוי כולל · מוצר מוגמר</small>
                    <Coverage
                      stock={f.tempo === null ? null : f.tempo + f.brewery}
                      daily={f.daily}
                      today={today}
                    />
                  </div>
                ))}
              </div>
              {upcoming(g.key)}
            </article>
          ))}
        </div>
      ) : (
        <div className="bp-table-scroll">
          <table className="bp-stock-table">
            <thead>
              <tr>
                <th>סגנון</th>
                <th>אריזה</th>
                <th>במבשלה</th>
                <th>טמפו · אומדן</th>
                <th>כיסוי טמפו</th>
                <th>כיסוי כולל</th>
                <th>פעולות הבאות</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((g) =>
                g.formats.map((f, i) => (
                  <tr key={g.key + f.type}>
                    {i === 0 && (
                      <th
                        rowSpan={2}
                        className={beerStyleClass(g.style).className}
                      >
                        {g.style}
                      </th>
                    )}
                    <td>{f.label}</td>
                    <td>{fmt(f.brewery)}</td>
                    <td>{f.tempo === null ? "—" : fmt(f.tempo)}</td>
                    <td>
                      <Coverage stock={f.tempo} daily={f.daily} today={today} />
                    </td>
                    <td>
                      <Coverage
                        stock={f.tempo === null ? null : f.tempo + f.brewery}
                        daily={f.daily}
                        today={today}
                      />
                    </td>
                    {i === 0 && <td rowSpan={2}>{upcoming(g.key)}</td>}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
