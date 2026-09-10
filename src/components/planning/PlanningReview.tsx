import { useState } from "react";
import {
  addDays,
  weekStart,
  type Actual,
  type Settings,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
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
  snapshots,
  error,
  today,
}: {
  settings: Settings;
  plans: WeekPlan[];
  actuals: Actual[];
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
