import { useState } from "react";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
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

const fmt = (n: number) => n.toLocaleString("he-IL", { maximumFractionDigits: 0 });

function cover(stock: number | null, daily: number) {
  if (!daily) return { label: "—", days: 0 };
  if (stock === null) return { label: "לא עודכן", days: 0 };
  const days = Math.max(0, Math.floor(stock / daily));
  return { label: days >= 7 ? `${(days / 7).toFixed(1)} שב׳` : `${days} ימים`, days };
}

function statusClass(status: string) {
  if (status === "נקבע") return "is-planned";
  if (status === "מסומן למשלוח") return "is-marked";
  return "is-recommended";
}

function measurementAge(today: string, date?: string) {
  if (!date) return Infinity;
  return Math.max(0, Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000));
}

function freshnessClass(age: number) {
  if (age >= 4) return "is-stale-critical";
  if (age >= 2) return "is-stale-warning";
  return "is-fresh";
}

export default function PlanningStock({ settings, pallets, today, actions, plans }: {
  settings: Settings;
  pallets: Pallet[];
  today: string;
  actions: PlanningAction[];
  plans: WeekPlan[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const nextActions: { kind: string; date: string; group: string; description: string; status: string }[] = [];

  const addProductAction = (kind: string, date: string, id: string, quantity: number, status: string) => {
    const p = settings.products.find((x) => x.id === id);
    if (p && date >= today && quantity > 0)
      nextActions.push({ kind, date, group: groupKey(p.style), description: `${fmt(quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"}`, status });
  };

  for (const w of plans) {
    w.packaging.forEach((r) => addProductAction("packaging", r.date ?? w.id, r.productId, r.quantity, "נקבע"));
    (w.deliveries ?? []).forEach((d) => addProductAction("delivery", d.dispatchDate, d.productId, d.quantity, d.id.startsWith("marked:") ? "מסומן למשלוח" : "נקבע"));
    w.brews.filter((b) => b.date >= today).forEach((b) => nextActions.push({ kind: "brew", date: b.date, group: groupKey(b.style), description: `${fmt(b.liters)} ל׳`, status: "נקבע" }));
  }
  for (const a of actions.filter((a) => a.date >= today)) {
    if (a.kind === "brew") nextActions.push({ kind: "brew", date: a.date, group: groupKey(a.style), description: `${fmt(a.liters)} ל׳`, status: "המלצה" });
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
        const brewery = inv.brewery + inv.dock;
        const tempo = product?.tempo ?? null;
        const daily = product ? weeklyDemand(product) / 7 : 0;
        const age = measurementAge(today, product?.tempoDate);
        return {
          type,
          product,
          brewery,
          dock: inv.dock,
          tempo,
          daily,
          age,
          tempoCover: cover(tempo, daily),
          totalCover: cover(tempo === null ? null : tempo + brewery, daily),
        };
      }),
    }));

  return (
    <section>
      <div className="bp-section-heading"><div><h2>מלאי וכיסוי</h2><p className="bp-muted">המלאי בטמפו מוצג לפי המדידה האחרונה, בלי הפחתת מכירות אוטומטית. מבשלה כוללת גם את הרמפה עד יציאת תעודת משלוח.</p></div></div>
      <div className="bp-stock-snapshot">
        {rows.map((g) => {
          const crates = g.formats.find((f) => f.type === "crates")!;
          const kegs = g.formats.find((f) => f.type === "kegs")!;
          const open = expanded === g.key;
          return (
            <article className={`bp-stock-snapshot-row ${open ? "is-open" : ""}`} key={g.key} role="button" tabIndex={0} aria-expanded={open}
              onClick={() => setExpanded((current) => current === g.key ? null : g.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((current) => current === g.key ? null : g.key); } }}>
              <div className={`bp-stock-style ${beerStyleClass(g.style).className}`}>{displayStyle(g.style)}</div>
              {[crates, kegs].map((f) => (
                <div className="bp-stock-metric" key={f.type}>
                  <small>{f.type === "crates" ? "בקבוקים · ארגזים" : "חביות"}</small>
                  <div className="bp-stock-pair"><span><b>מבשלה</b> {fmt(f.brewery)}</span><span><b>טמפו</b> {f.tempo === null ? "—" : fmt(f.tempo)}</span></div>
                  <em>כיסוי כולל {f.totalCover.label}</em>
                  <i className={`bp-stock-freshness ${freshnessClass(f.age)}`}>{f.product?.tempoDate ? `עודכן ${shortDate(f.product.tempoDate)}` : "לא עודכן"}</i>
                </div>
              ))}
              {open && (
                <div className="bp-stock-detail" onClick={(e) => e.stopPropagation()}>
                  {g.formats.map((f) => (
                    <div key={f.type}>
                      <b>{f.type === "crates" ? "בקבוקים / ארגזים" : "חביות"}</b>
                      <span>מלאי במבשלה: {fmt(f.brewery)}</span>
                      {f.dock > 0 && <span>מתוכם ברמפה: {fmt(f.dock)}</span>}
                      <span>מלאי בטמפו: {f.tempo === null ? "לא עודכן" : fmt(f.tempo)}</span>
                      <span className={`bp-stock-freshness ${freshnessClass(f.age)}`}>{f.product?.tempoDate ? `עודכן לאחרונה: ${shortDate(f.product.tempoDate)}` : "לא קיימת מדידת טמפו"}</span>
                      <span>כיסוי בטמפו: {f.tempoCover.label}</span>
                      <span>כיסוי כולל: {f.totalCover.label}</span>
                      {f.tempo !== null && f.daily > 0 && <small>בקצב הנוכחי הכיסוי הכולל שקול עד {shortDate(addDays(today, f.totalCover.days))}</small>}
                    </div>
                  ))}
                  <div><b>פעולות קרובות</b>{nextActions.filter((a) => a.group === g.key).slice(0, 6).map((a, i) => <span key={`${a.date}:${a.kind}:${i}`}>{shortDate(a.date)} · {a.description} · <b className={`bp-status-chip ${statusClass(a.status)}`}>{a.status}</b></span>)}{!nextActions.some((a) => a.group === g.key) && <span>אין פעולות קרובות</span>}</div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
