import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  inventory,
  tempoNow,
  weeklyDemand,
  addDays,
  type Settings,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import type { PlanningAction } from "../../SERVICES/planning/workspace";
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
  if (stock === null) return <span>נדרשת מדידת מלאי</span>;
  const days = Math.max(0, Math.floor(stock / daily));
  if (!days) return <strong>פחות מיום</strong>;
  return (
    <div className="bp-coverage">
      <strong>
        {Math.floor(days / 7)} שבועות{days % 7 ? ` ו־${days % 7} ימים` : ""}
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
  openCalendar,
}: {
  settings: Settings;
  pallets: Pallet[];
  today: string;
  actions: PlanningAction[];
  plans: WeekPlan[];
  openCalendar: () => void;
}) {
  const products = settings.products
    .filter((p) => p.monthly > 0)
    .sort(
      (a, b) =>
        (tempoNow(a, today) ?? -1) / weeklyDemand(a) -
        (tempoNow(b, today) ?? -1) / weeklyDemand(b),
    );
  return (
    <section>
      <div className="bp-section-heading">
        <h2>מה דורש תשומת לב?</h2>
        <button onClick={openCalendar}>ללוח העבודה</button>
      </div>
      <div className="bp-stock-grid">
        {products.map((p) => {
          const inv = inventory(p, pallets),
            brewery = inv.brewery + inv.dock,
            tempo = tempoNow(p, today);
          const decisions = plans.flatMap((w) => [
            ...w.packaging
              .filter((r) => r.date && r.quantity > 0)
              .map((r) => ({
                kind: "packaging" as const,
                date: r.date!,
                productId: r.productId,
                quantity: r.quantity,
              })),
            ...(w.deliveries ?? []).map((d) => ({
              kind: "delivery" as const,
              date: d.dispatchDate,
              productId: d.productId,
              quantity: d.quantity,
            })),
          ]);
          const next = [...decisions.filter((d) => d.date >= today), ...actions]
            .sort((a, b) => a.date.localeCompare(b.date))
            .find((a) => a.kind !== "brew" && a.productId === p.id);
          return (
            <article className="bp-card" key={p.id}>
              <h3 className={beerStyleClass(p.style).className}>
                {p.style} · {p.type === "crates" ? "ארגזים" : "חביות"}
              </h3>
              <div className="bp-stock-amounts">
                <div>
                  <small>בטמפו · אומדן להיום</small>
                  <strong>{tempo === null ? "—" : fmt(tempo)}</strong>
                </div>
                <div>
                  <small>במבשלה · כל האזורים</small>
                  <strong>{fmt(brewery)}</strong>
                </div>
              </div>
              <div className="bp-fields">
                <div>
                  <small>טמפו מספיק לעוד</small>
                  <Coverage
                    stock={tempo}
                    daily={weeklyDemand(p) / 7}
                    today={today}
                  />
                </div>
                <div>
                  <small>מלאי מוגמר כולל</small>
                  <Coverage
                    stock={tempo === null ? null : tempo + brewery}
                    daily={weeklyDemand(p) / 7}
                    today={today}
                  />
                </div>
              </div>
              <button className="bp-next-action" onClick={openCalendar}>
                {next && next.kind !== "brew"
                  ? `${next.kind === "delivery" ? "לשלוח" : "לארוז"} ${fmt(next.quantity)} · ${shortDate(next.date)}`
                  : tempo === null
                    ? "עדכנו מלאי טמפו כדי לחשב פעולה"
                    : "לבדיקת לוח העבודה והייצור הבא"}
              </button>
            </article>
          );
        })}
      </div>
      {!products.length && (
        <p>הזינו צפי מכירות ב״נתונים והגדרות״ כדי להתחיל לתכנן.</p>
      )}
    </section>
  );
}
