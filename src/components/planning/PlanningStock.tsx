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

function cover(stock: number | null, daily: number) {
  if (!daily) return { label: "—", days: 0 };
  if (stock === null) return { label: "לא עודכן", days: 0 };
  const days = Math.max(0, Math.floor(stock / daily));
  return {
    label: days >= 7 ? `${(days / 7).toFixed(1)} שב׳` : `${days} ימים`,
    days,
  };
}

function statusClass(status: string) {
  if (status === "נקבע") return "is-planned";
  if (status === "מסומן למשלוח") return "is-marked";
  if (status === "המלצה") return "is-recommended";
  return "is-unassigned";
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const nextActions: {
    kind: string;
    date: string;
    group: string;
    description: string;
    status: string;
  }[] = [];

  const addProductAction = (
    kind: string,
    date: string,
    id: string,
    quantity: number,
    status: string,
  ) => {
    const p = settings.products.find((x) => x.id === id);
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
      addProductAction("packaging", r.date ?? w.id, r.productId, r.quantity, "נקבע"),
    );
    (w.deliveries ?? []).forEach((d) =>
      addProductAction(
        "delivery",
        d.dispatchDate,
        d.productId,
        d.quantity,
        d.id.startsWith("marked:") ? "מסומן למשלוח" : "נקבע",
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
          status: "נקבע",
        }),
      );
  }

  for (const a of actions.filter((a) => a.date >= today)) {
    if (a.kind === "brew")
      nextActions.push({
        kind: "brew",
        date: a.date,
        group: groupKey(a.style),
        description: `${fmt(a.liters)} ל׳`,
        status: "המלצה",
      });
    else addProductAction(a.kind, a.date, a.productId, a.quantity, "המלצה");
  }

  // A need is not another recommendation. It means demand exists but the
  // planner currently has no feasible resource assignment for it.
  for (const need of needs.filter((n) => n.date >= today))
    nextActions.push({
      kind: need.kind,
      date: need.date,
      group: groupKey(need.style),
      description: `${fmt(need.quantity)} ${need.unit}`,
      status: "חוסר ללא שיבוץ",
    });

  nextActions.sort((a, b) => a.date.localeCompare(b.date));

  const rows = styleGroups(settings)
    .filter((g) => g.key === "special" || g.products.some((p) => p.monthly > 0))
    .map((g) => ({
      ...g,
      formats: (["crates", "kegs"] as const).map((type) => {
        const product = g.products.find((p) => p.type === type);
        const brewery = pallets
          .filter(
            (p) =>
              p.zone !== "shipped" &&
              p.itemType === type &&
              groupKey(p.beerStyle) === g.key,
          )
          .reduce((sum, p) => sum + num(p.quantity), 0);
        const tempo = product ? tempoNow(product, today) : null;
        const daily = product ? weeklyDemand(product) / 7 : 0;
        return {
          type,
          product,
          brewery,
          tempo,
          daily,
          tempoCover: cover(tempo, daily),
          totalCover: cover(tempo === null ? null : tempo + brewery, daily),
        };
      }),
    }));

  const nextFor = (key: string, kind: string) =>
    nextActions.find((a) => a.group === key && a.kind === kind);

  return (
    <section>
      <div className="bp-section-heading">
        <div>
          <h2>מלאי וכיסוי</h2>
          <p className="bp-muted">
            תמונת מצב קומפקטית. לחיצה על סגנון פותחת פירוט.
          </p>
        </div>
      </div>

      <div className="bp-stock-snapshot">
        {rows.map((g) => {
          const crates = g.formats.find((f) => f.type === "crates")!;
          const kegs = g.formats.find((f) => f.type === "kegs")!;
          const next = [
            nextFor(g.key, "packaging"),
            nextFor(g.key, "delivery"),
            nextFor(g.key, "brew"),
          ]
            .filter(Boolean)
            .sort((a, b) => a!.date.localeCompare(b!.date))[0];

          return (
            <article className="bp-stock-snapshot-row" key={g.key}>
              <button
                className={`bp-stock-style ${beerStyleClass(g.style).className}`}
                onClick={() => setExpanded(expanded === g.key ? null : g.key)}
              >
                {g.style}
              </button>

              <div className="bp-stock-metrics">
                <div className="bp-stock-metric">
                  <small>בקבוקים</small>
                  <strong>{fmt(crates.brewery)} ארגזים</strong>
                  <span>
                    טמפו: {crates.tempo === null ? "—" : `${fmt(crates.tempo)} ארגזים`}
                  </span>
                  <em>{crates.totalCover.label}</em>
                </div>
                <div className="bp-stock-metric">
                  <small>חביות</small>
                  <strong>{fmt(kegs.brewery)} חביות</strong>
                  <span>
                    טמפו: {kegs.tempo === null ? "—" : `${fmt(kegs.tempo)} חביות`}
                  </span>
                  <em>{kegs.totalCover.label}</em>
                </div>
              </div>

              <div className="bp-stock-next">
                <small>הפעולה הקרובה</small>
                {next ? (
                  <>
                    <span>
                      <bdi>{shortDate(next.date)}</bdi> · {next.description}
                    </span>
                    <b className={`bp-status-chip ${statusClass(next.status)}`}>
                      {next.status}
                    </b>
                  </>
                ) : (
                  <span>אין פעולה קרובה</span>
                )}
              </div>

              {expanded === g.key && (
                <div className="bp-stock-detail">
                  {g.formats.map((f) => (
                    <div key={f.type}>
                      <b>{f.type === "crates" ? "בקבוקים" : "חביות"}</b>
                      <span>כיסוי בטמפו: {f.tempoCover.label}</span>
                      <span>כיסוי כולל: {f.totalCover.label}</span>
                      {f.tempo !== null && f.daily > 0 && (
                        <small>
                          אומדן עד {shortDate(addDays(today, f.totalCover.days))}
                        </small>
                      )}
                    </div>
                  ))}
                  <div>
                    <b>פעולות קרובות</b>
                    {nextActions
                      .filter((a) => a.group === g.key)
                      .slice(0, 5)
                      .map((a, i) => (
                        <span key={i}>
                          {shortDate(a.date)} · {a.description} · {a.status}
                        </span>
                      ))}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
