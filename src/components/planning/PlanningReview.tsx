import { useState } from "react";
import {
  addDays,
  weekStart,
  weeklyDemand,
  tempoNow,
  type Actual,
  type Settings,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { actualDate, matchesActual, shortDate } from "../../SERVICES/planning/dailyPlanner";
import { matchActualShipments } from "../../SERVICES/planning/shipmentActuals";
import type { ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import {
  CHECKPOINTS,
  checkpointLabel,
  compareProduct,
  compareSnapshots,
  learningAdvice,
  type Checkpoint,
  type PlanningSnapshot,
} from "../../SERVICES/planning/planningReports";
const fmt = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("he-IL", { maximumFractionDigits: 1 });
export default function PlanningReview({
  settings,
  plans,
  actuals,
  shipments,
  snapshots,
  error,
  today,
}: {
  settings: Settings;
  plans: WeekPlan[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  snapshots: PlanningSnapshot[];
  error: string;
  today: string;
}) {
  const [week, setWeek] = useState(weekStart(today)),
    [checkpoint, setCheckpoint] = useState<Checkpoint>("opening");
  const snapshot = snapshots.find(
    (x) => x.targetWeek === week && x.checkpoint === checkpoint,
  );
  const baseline = snapshot?.state === "captured" ? snapshot.plan : null;
  const products = snapshot?.settings?.products ?? settings.products;
  const suggestions = learningAdvice(
    settings.products,
    snapshots,
    actuals,
    today,
  );
  return (
    <section>
      <h2>תכנון מול ביצוע</h2>
      <div className="bp-fields">
        <label>
          שבוע להשוואה
          <select value={week} onChange={(e) => setWeek(e.target.value)}>
            {Array.from({ length: 16 }, (_, i) =>
              addDays(weekStart(today), (3 - i) * 7),
            ).map((d) => (
              <option key={d} value={d}>
                {shortDate(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          בסיס ההשוואה
          <select
            value={checkpoint}
            onChange={(e) => setCheckpoint(e.target.value as Checkpoint)}
          >
            {CHECKPOINTS.map((c) => (
              <option key={c} value={c}>
                {checkpointLabel[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="bp-alert">לא ניתן לקרוא את גרסאות התכנון: {error}</p>
      )}
      {!snapshot && (
        <p className="bp-alert">
          טרם נשמרה תמונת מצב לנקודת הזמן שנבחרה. הדוח אינו משתמש בתוכנית החיה
          כתחליף.
        </p>
      )}
      {snapshot?.state === "no-plan" && (
        <p className="bp-alert">
          במועד השמירה לא הוגשה תוכנית לשבוע זה. זה אינו תכנון של אפס.
        </p>
      )}
      {snapshot?.state === "history-unavailable" && (
        <p className="bp-alert">
          אין היסטוריה אמינה לשחזור המועד שנבחר. התוכנית הנוכחית לא תוצג כתוכנית
          עבר.
        </p>
      )}
      {addDays(week, 7) > today && (
        <p className="bp-muted">
          השבוע טרם הסתיים: הביצוע והפערים המוצגים הם זמניים.
        </p>
      )}
      <section className="bp-card" aria-label="מדדי תוצאות תכנון">
        <h3>מדדי תוצאות — אריזה ומשלוחים</h3>
        {baseline ? (() => {
          const matched = matchActualShipments(baseline.deliveries ?? [], shipments, products);
          const completed = matched.filter((row) => row.actual);
          const withQuantities = completed.filter((row) => row.score !== null);
          const delay = completed.reduce((sum, row) => sum +
            Math.round((Date.parse(row.actual!.date + "T12:00:00Z") -
              Date.parse(row.planned.dispatchDate + "T12:00:00Z")) / 86400000), 0);
          return <div>
            <p>משלוחים שבוצעו: {completed.length} מתוך {matched.length} מתוכננים.
              {" · "}התאמת הרכב וכמויות: {withQuantities.length ?
                `${fmt(withQuantities.reduce((sum, row) => sum + row.score! * 100, 0) / withQuantities.length)}%` :
                "חסר פירוט כמויות מאומת"}.
              {" · "}סטייה ממוצעת בתאריך: {completed.length ? `${fmt(delay / completed.length)} ימים` : "אין משלוח מתאים"}.
            </p>
            <small>ההתאמה נעשית רק בין משלוח מתוכנן למשלוח מדווח באותו שבוע; משלוח שלא תועד נשאר חסר ולא מיוחס לו ביצוע.</small>
          </div>;
        })() : null}
        {baseline && addDays(week, 7) <= today ? (() => {
          const results = products.map((product) => compareProduct(product, baseline, actuals, week));
          const withPlan = results.filter((item) => (item.planned ?? 0) > 0);
          const matched = results.reduce((sum, item) => sum + item.matched, 0);
          const delayed = results.reduce((sum, item) => sum + (item.delay ?? 0) * item.matched, 0);
          return <>
            <p>פריטי אריזה עם תוכנית מדידה: {withPlan.length} מתוך {products.length}</p>
            <p>עמידה ממוצעת בכמויות לפי פריט: {withPlan.length ? `${fmt(withPlan.reduce((sum, item) => sum + Math.min(100, item.attainment ?? 0), 0) / withPlan.length)}%` : "אין כמות מתוכננת למדידה"}</p>
            <p>סטייה ממוצעת בתזמון ליחידות שהותאמו: {matched > 0 ? `${fmt(delayed / matched)} ימים` : "אין התאמות מתוארכות"}</p>
            <small>המדד הוא ממוצע לא־משוקלל בין פריטי אריזה שונים. אין חיבור מלאכותי בין חביות לארגזים. לשבוע שטרם הסתיים הנתונים זמניים.</small>
          </>;
        })() : <p>{!baseline ? "לא ניתן לחשב מדד ביצוע ללא תמונת תכנון היסטורית אמינה." : "השבוע טרם הסתיים — מדד הביצוע הסופי יוצג לאחר סיומו."}</p>}
        {baseline && snapshot?.settings ? (() => {
          const target = snapshot.settings.targetWeeks;
          const rows = products.filter((product) => product.monthly > 0).map((product) => {
            const stock = tempoNow(product, week);
            const demand = weeklyDemand(product);
            if (stock === null || demand <= 0) return null;
            const deliveries = (baseline.deliveries ?? []).filter((run) => run.productId === product.id)
              .reduce((sum, run) => sum + run.quantity, 0);
            // Tempo is downstream stock: dispatches add to it; packaged beer
            // stays in the brewery until a recorded/planned transfer.
            const endStock = stock + deliveries - demand;
            const cover = endStock / demand;
            return { product, cover, shortage: Math.max(0, -endStock), excess: Math.max(0, cover - target) };
          }).filter((row): row is NonNullable<typeof row> => row !== null);
          return <div>
            <h4>סיכוני מלאי לפי תמונת התכנון שנשמרה</h4>
            <p>פריטים עם נתוני מלאי וביקוש: {rows.length} · תחזית מלאי שלילי: {rows.filter((row) => row.shortage > 0).length} · מעל יעד כיסוי {fmt(target)} שבועות: {rows.filter((row) => row.excess > 0).length}</p>
            <small>סימולציה בלבד על בסיס מלאי טמפו שהוקפא, ביקוש ממוצע ומשלוחים שתוכננו להגיע לטמפו. אינה כוללת מלאי היסטורי מאומת, ביצועי משלוחים בפועל או מלאי במבשלה; לכן אינה מודדת מחסור או עודף שהתממשו.</small>
          </div>;
        })() : <p>סיכוני מלאי: אין תמונת תכנון והגדרות היסטוריות אמינות.</p>}
        {baseline ? (() => {
          const plannedDates = new Set(baseline.packaging.map((run) => run.date).filter((date): date is string => Boolean(date)));
          const actualDates = new Set(actuals.filter((row) => products.some((product) => matchesActual(product, row)))
            .map(actualDate).filter((date): date is string => Boolean(date) && weekStart(date!) === week));
          const capacity = baseline.maxRuns;
          return <p>ניצול מכסת ימי אריזה: {actualDates.size} ימי ביצוע מתוך מכסה של {capacity}
            {capacity > 0 ? ` (${fmt(actualDates.size / capacity * 100)}%)` : " (ללא מכסה)"}
            {" · "}תוכננו {plannedDates.size} ימים מתוארכים.
            <small>נמדד לפי ימי אריזה ייחודיים בדיווחי ביצוע. חריגה מעל 100% אפשרית. לא מודד שעות, תפוקה או יעילות משמרת.</small>
          </p>;
        })() : null}
        <p>ציון איכות עסקית בפועל אינו מחושב ללא תוצאות מלאי ומשלוח היסטוריות מאומתות.</p>
      </section>
      <section className="bp-card" aria-label="ראיות להחלטות המתכנן">
        <h3>תיעוד החלטות והמלצות</h3>
        {(() => {
          const evidence = plans.find((plan) => plan.id === week)?.recommendationEvidence ?? [];
          if (!evidence.length) return <p>אין תיעוד החלטות שנשמר לשבוע זה. אין להסיק מכך שלא התקבלו החלטות.</p>;
          return <>
            <p>נשמרו {evidence.length} נקודות תיעוד. תאריך השמירה אינו תאריך ההחלטה המקורית של תוכנית קיימת.</p>
            {(["shipment", "packaging", "brewing"] as const).map((kind) => {
              const rows = evidence.filter((entry) => entry.kind === kind);
              const original = rows.filter((entry) => entry.provenance === "decision-time" && entry.recommended.length > 0);
              const recomputed = rows.filter((entry) => entry.provenance === "recomputed-at-save");
              const baselineRows = rows.filter((entry) => entry.provenance === "existing-plan-baseline");
              return <p key={kind}>
                {kind === "shipment" ? "משלוחים" : kind === "packaging" ? "אריזות" : "בישולים"}:
                {" "}{original.length} השוואות המלצה–החלטה;
                {" "}{baselineRows.length} צילומי החלטה קיימת ללא המלצת עבר;
                {" "}{recomputed.length} המלצות שחושבו מחדש בעת השמירה (לא המלצה היסטורית)
              </p>;
            })}
            {(() => {
              const eligible = evidence.filter((entry) => entry.provenance === "decision-time" && entry.recommended.length > 0);
              if (!eligible.length) return <p>איכות המלצות המנוע: אין עדיין זוגות המלצה–החלטה מקוריים למדידה.</p>;
              const comparable = eligible.map((entry) => {
                const totals = (items: Record<string, unknown>[]) => {
                  const map = new Map<string, number>();
                  for (const item of items) {
                    const key = entry.kind === "brewing" ? String(item.style ?? "") : String(item.productId ?? "");
                    const quantity = Number(entry.kind === "brewing" ? item.liters : item.quantity);
                    if (!key || !Number.isFinite(quantity) || quantity < 0) continue;
                    map.set(key, (map.get(key) ?? 0) + quantity);
                  }
                  return map;
                };
                const recommended = totals(entry.recommended), decided = totals(entry.decided);
                const keys = new Set([...recommended.keys(), ...decided.keys()]);
                const distance = [...keys].reduce((sum, key) => sum + Math.abs((recommended.get(key) ?? 0) - (decided.get(key) ?? 0)), 0);
                const scale = [...keys].reduce((sum, key) => sum + Math.max(recommended.get(key) ?? 0, decided.get(key) ?? 0), 0);
                return scale > 0 ? Math.max(0, 100 * (1 - distance / scale)) : null;
              }).filter((value): value is number => value !== null);
              return <p>התאמה כמותית בין המלצת המנוע להחלטה: {comparable.length ? `${fmt(comparable.reduce((sum, value) => sum + value, 0) / comparable.length)}%` : "אין זוגות כמותיים תקפים"} · מדד משני בלבד, לא איכות החלטה ולא איכות עסקית.</p>;
            })()}
            <small>תיעוד אינו ציון איכות. מדדי מחסור, עודף מלאי וניצול קיבולת מחייבים נתוני תוצאה אמינים, ואינם מוסקים מהסכמה עם המנוע.</small>
          </>;
        })()}
      </section>
      <div className="bp-table-wrap">
        <table>
          <thead>
            <tr>
              <th>פריט</th>
              <th>תוכנן</th>
              <th>בוצע</th>
              <th>פער כמות</th>
              <th>אחוז ביצוע</th>
              <th>סטייה ממוצעת בימים</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const r = compareProduct(p, baseline, actuals, week);
              if (!r.planned && !r.performed) return null;
              return (
                <tr key={p.id}>
                  <th>
                    {p.style} · {p.type === "crates" ? "ארגזים" : "חביות"}
                  </th>
                  <td>{fmt(r.planned)}</td>
                  <td>{fmt(r.performed)}</td>
                  <td>{fmt(r.delta)}</td>
                  <td>
                    {r.attainment === null ? "—" : `${fmt(r.attainment)}%`}
                  </td>
                  <td>{fmt(r.delay)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="bp-muted">
        סטייה חיובית = איחור. התאמת כמויות לפי פריט וסדר תאריכים בתוך אותו שבוע;
        כמות שלא בוצעה אינה מקבלת תאריך ביצוע מדומה. העברה לשבוע אחר נבחנת בנפרד
        ואינה משויכת אוטומטית.
      </p>
      <h3>כיצד השתנתה התוכנית?</h3>
      <div className="bp-table-wrap">
        <table>
          <thead>
            <tr>
              <th>פריט</th>
              {CHECKPOINTS.map((c) => (
                <th key={c}>{checkpointLabel[c]}</th>
              ))}
              <th>תוכנית חיה</th>
            </tr>
          </thead>
          <tbody>
            {products
              .filter(
                (p) =>
                  p.monthly > 0 ||
                  snapshots.some(
                    (s) =>
                      s.targetWeek === week &&
                      s.plan?.packaging.some((r) => r.productId === p.id),
                  ),
              )
              .map((p) => (
                <tr key={p.id}>
                  <th>
                    {p.style} · {p.type === "crates" ? "ארגזים" : "חביות"}
                  </th>
                  {compareSnapshots(p, snapshots, week).map((s) => (
                    <td key={s.key}>
                      {fmt(s.quantity)}
                      <small>
                        {s.state === "no-plan"
                          ? "לא הוגש"
                          : s.state === "missing"
                            ? "טרם נשמר"
                            : s.state === "history-unavailable"
                              ? "אין היסטוריה"
                              : ""}
                      </small>
                    </td>
                  ))}
                  <td>
                    {fmt(
                      plans
                        .find((w) => w.id === week)
                        ?.packaging.filter((r) => r.productId === p.id)
                        .reduce((s, r) => s + r.quantity, 0) ?? null,
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <h3>הסיבות שנשמרו עם הגרסאות</h3>
      {CHECKPOINTS.map((c) => {
        const s = snapshots.find(
          (x) => x.targetWeek === week && x.checkpoint === c,
        );
        return s?.plan ? (
          <p key={c}>
            {checkpointLabel[c]}: {s.plan.changeReason || "לא צוינה סיבה"}
            {s.plan.note ? ` · ${s.plan.note}` : ""}
          </p>
        ) : null;
      })}
      <h3>הצעות לשיפור — לא שינוי אוטומטי</h3>
      {!suggestions.length ? (
        <p>
          נדרשים לפחות ארבעה שבועות שהושלמו עם גרסת פתיחה. כרגע אין מספיק ראיות
          לסטייה עקבית.
        </p>
      ) : (
        suggestions.map((s) => (
          <article className="bp-card" key={s.productId}>
            <h4>
              {settings.products.find((p) => p.id === s.productId)?.style} ·{" "}
              {settings.products.find((p) => p.id === s.productId)?.type ===
              "crates"
                ? "ארגזים"
                : "חביות"}
            </h4>
            <p>
              {s.weeks} שבועות · ביצוע מצטבר {fmt(s.ratio * 100)}% מהתכנון
            </p>
            <p>{s.message}</p>
            <small>{s.suggestedReview}</small>
          </article>
        ))
      )}
      <p className="bp-muted">
        זהו מדד לתכנון וביצוע אריזות, לא דיוק ביקוש ולא ציון אישי למתכנן. אין
        עדיין נתוני מכירות, מלאי היסטורי בטמפו או היסטוריית מוכנות איכות מספקים
        למדידת מחסור בפועל או ללמידת זמני הבשלה ופחת.
      </p>
    </section>
  );
}
