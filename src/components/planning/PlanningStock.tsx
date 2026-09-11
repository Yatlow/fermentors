import { useState } from "react";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  tempoNow,
  weeklyDemand,
  addDays,
  inventory,
  type Settings,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import {
  displayStyle,
  groupKey,
  styleGroups,
} from "../../SERVICES/planning/planningPresentation";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import type { PlanningAction } from "../../SERVICES/planning/workspace";

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
  return "is-recommended";
}

export default function PlanningStock({
  settings,
  pallets,
  today,
  actions,
  plans,
}: {
  settings: Settings;
  pallets: Pallet[];
  today: string;
  actions: PlanningAction[];
  plans: WeekPlan[];
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
  nextActions.sort((a, b) => a.date.localeCompare(b.date));

  const rows = styleGroups(settings)
    .filter((g) => g.products.some((p) => p.monthly > 0))
    .map((g) => ({
      ...g,
      formats: (["crates", "kegs"] as const).map((type) => {
        const product = g.products.find((p) => p.type === type);
        const inv = product ? inventory(product, pallets) : { brewery: 0, dock: 0 };
        const tempo = product ? tempoNow(product, today) : null;
        const daily = product ? weeklyDemand(product) / 7 : 0;
        return {
          type,
          product,
          brewery: inv.brewery,
          dock: inv.dock,
          tempo,
          daily,
          tempoCover: cover(tempo, daily),
          totalCover: cover(tempo === null ? null : tempo + inv.brewery, daily),
        };
      }),
    }));

  function toggle(key: string) {
    setExpanded((current) => (current === key ? null : key));
  }

  return (
    <section>
      <div className="bp-section-heading">
        <div>
          <h2>מלאי וכיסוי</h2>
          <p className="bp-muted">מבשלה וטמפו מוצגים בנפרד. לחיצה על כל השורה פותחת פירוט.</p>
        </div>
      </div>

      <div className="bp-stock-snapshot">
        {rows.map((g) => {
          const crates = g.formats.find((f) => f.type === "crates")!;
          const kegs = g.formats.find((f) => f.type === "kegs")!;
          const open = expanded === g.key;
          return (
            <article
              className={`bp-stock-snapshot-row ${open ? "is-open" : ""}`}
              key={g.key}
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => toggle(g.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(g.key);
                }
              }}
            >
              <div className={`bp-stock-style ${beerStyleClass(g.style).className}`}>
                {displayStyle(g.style)}
              </div>

              <div className="bp-stock-metric">
                <small>בקבוקים · ארגזים</small>
                <div className="bp-stock-pair">
                  <span><b>מבשלה</b> {fmt(crates.brewery)}</span>
                  <span><b>טמפו</b> {crates.tempo === null ? "—" : fmt(crates.tempo)}</span>
                </div>
                <em>כיסוי כולל {crates.totalCover.label}</em>
              </div>

              <div className="bp-stock-metric">
                <small>חביות</small>
                <div className="bp-stock-pair">
                  <span><b>מבשלה</b> {fmt(kegs.brewery)}</span>
                  <span><b>טמפו</b> {kegs.tempo === null ? "—" : fmt(kegs.tempo)}</span>
                </div>
                <em>כיסוי כולל {kegs.totalCover.label}</em>
              </div>

              {open && (
                <div className="bp-stock-detail" onClick={(e) => e.stopPropagation()}>
                  {g.formats.map((f) => (
                    <div key={f.type}>
                      <b>{f.type === "crates" ? "בקבוקים / ארגזים" : "חביות"}</b>
                      <span>מלאי במבשלה: {fmt(f.brewery)}</span>
                      <span>מלאי בטמפו: {f.tempo === null ? "לא עודכן" : fmt(f.tempo)}</span>
                      {f.dock > 0 && <span>ברציף / מיועד ליציאה: {fmt(f.dock)}</span>}
                      <span>כיסוי בטמפו: {f.tempoCover.label}</span>
                      <span>כיסוי כולל: {f.totalCover.label}</span>
                      {f.tempo !== null && f.daily > 0 && (
                        <small>אומדן כולל עד {shortDate(addDays(today, f.totalCover.days))}</small>
                      )}
                    </div>
                  ))}
                  <div>
                    <b>פעולות קרובות</b>
                    {nextActions.filter((a) => a.group === g.key).slice(0, 6).map((a, i) => (
                      <span key={`${a.date}:${a.kind}:${i}`}>
                        {shortDate(a.date)} · {a.description} · <b className={`bp-status-chip ${statusClass(a.status)}`}>{a.status}</b>
                      </span>
                    ))}
                    {!nextActions.some((a) => a.group === g.key) && <span>אין פעולות קרובות</span>}
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
