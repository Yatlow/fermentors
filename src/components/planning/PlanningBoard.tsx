import { useState } from "react";
import type { Fermentor } from "../../App";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  parseDate,
  weekStart,
  weekNumber,
  type Actual,
  type Holiday,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import {
  actualDate,
  futureTanks,
  shortDate,
  validateDatedPlan,
  type ShipmentEvent,
} from "../../SERVICES/planning/dailyPlanner";
import {
  validateProduction,
  validateBrewReleases,
} from "../../SERVICES/planning/productionCycle";
import {
  adoptAction,
  type PlanningAction,
  type planningWorkspace,
} from "../../SERVICES/planning/workspace";
import PlanningWeekEditor from "./PlanningWeekEditor";
import TruckRecommendations from "./TruckRecommendations";

const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
type Workspace = ReturnType<typeof planningWorkspace>;
export default function PlanningBoard({
  settings,
  plans,
  tanks,
  brews,
  actuals,
  shipments,
  today,
  holidays,
  workspace,
  disabled,
  saveWeek,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  brews: Fermentor[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  today: string;
  holidays: Holiday[];
  workspace: Workspace;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [horizon, setHorizon] = useState(4);
  const [draft, setDraft] = useState<WeekPlan | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const current = plans.find((w) => w.id === week) ?? {
    ...emptyWeek(week),
    maxRuns: settings.preferredRuns,
  };
  const effective =
    workspace.effectivePlans.find((w) => w.id === week) ?? current;
  const actions = workspace.actions.filter((a) => weekStart(a.date) === week);
  const name = (id: string) => {
    const p = settings.products.find((p) => p.id === id);
    return p ? `${p.style} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };
  async function persist(next: WeekPlan) {
    for (const date of next.deliveryDates ?? [])
      if (!parseDate(date) || weekStart(date) !== next.id)
        throw new Error("יום האיסוף חייב להיות בתוך השבוע");
    const error = validateDatedPlan(next, settings, plans, today);
    if (error) throw new Error(error);
    const all = [...plans.filter((w) => w.id !== next.id), next];
    // Assumed brewing may supply an accepted future packaging run, but stays visibly a recommendation.
    const assumedBrews = workspace.scenario.map((w) => ({
      ...w,
      ...all.find((x) => x.id === w.id),
      brews: [
        ...(all.find((x) => x.id === w.id)?.brews ?? []),
        ...w.brews.filter(
          (b) =>
            !plans.flatMap((x) => x.brews).some((x) => x.id === b.id) &&
            !all.flatMap((x) => x.brews).some((x) => x.id === b.id),
        ),
      ],
    }));
    for (const w of all)
      if (!assumedBrews.some((x) => x.id === w.id)) assumedBrews.push(w);
    const production = validateProduction(
      all,
      settings,
      futureTanks(tanks, assumedBrews, settings),
      actuals,
      today,
    );
    if (production) throw new Error(production);
    // Replacing this week's draft also replaces its previous hypothetical depletion.
    const dependent = workspace.hypothetical.map((w) => {
      const saved = all.find((x) => x.id === w.id);
      if (!saved) return w;
      return {
        ...saved,
        packaging: [
          ...saved.packaging,
          ...w.packaging.filter(
            (r) =>
              r.source === "recommendation" &&
              !saved.packaging.some((x) => x.id === r.id) &&
              !(saved.dismissedRecommendations ?? []).includes(r.id ?? "") &&
              !saved.packaging.some((x) => x.date === r.date),
          ),
        ],
      };
    });
    for (const w of all)
      if (!dependent.some((x) => x.id === w.id)) dependent.push(w);
    const dependency = validateBrewReleases(
      brews,
      tanks,
      dependent,
      settings,
      actuals,
      today,
    );
    if (dependency) throw new Error(dependency);
    await saveWeek(next);
    setDraft(null);
    setMessage("ההחלטות נשמרו");
  }
  async function hide(id: string) {
    setBusy(true);
    setMessage("");
    try {
      await saveWeek({
        ...current,
        dismissedRecommendations: [
          ...new Set([...(current.dismissedRecommendations ?? []), id]),
        ],
        changeReason: "הסתרת המלצה לתאריך זה",
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }
  function editAction(action: PlanningAction) {
    setDraft(adoptAction(current, action));
  }
  return (
    <section>
      <div className="bp-section-heading">
        <h2>לוח העבודה</h2>
        <label>
          אופק
          <select
            value={horizon}
            onChange={(e) => {
              setHorizon(Number(e.target.value));
              setWeek(weekStart(today));
            }}
            disabled={!!draft}
          >
            {[4, 8, 12].map((n) => (
              <option value={n} key={n}>
                {n} שבועות
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="bp-muted">
        מומלץ = נכלל בתחזית. נקבע = החלטה שנשמרה. בוצע = דיווח שהתקבל.
      </p>
      <div className="bp-week-picker">
        {Array.from({ length: horizon }, (_, i) =>
          addDays(weekStart(today), i * 7),
        ).map((w) => (
          <button
            key={w}
            aria-pressed={week === w}
            disabled={!!draft}
            onClick={() => setWeek(w)}
          >
            שבוע {weekNumber(w)}
            <small>
              <bdi>{shortDate(w)}</bdi>
            </small>
          </button>
        ))}
      </div>
      <div className="bp-actions">
        <button
          disabled={disabled || busy || !!draft}
          onClick={() => setDraft(structuredClone(effective))}
        >
          עריכת השבוע וימי האיסוף
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {draft && (
        <PlanningWeekEditor
          key={draft.id}
          initial={draft}
          settings={settings}
          tanks={futureTanks(tanks, workspace.scenario, settings)}
          brews={brews}
          disabled={disabled || busy}
          onSave={persist}
          onCancel={() => setDraft(null)}
        />
      )}
      <div className="bp-calendar">
        {days.map((day, i) => {
          const date = addDays(week, i);
          const recommendations = actions.filter((a) => a.date === date);
          const deliveries = (effective.deliveries ?? []).filter(
            (d) => d.dispatchDate === date,
          );
          const packs = current.packaging.filter((r) => r.date === date);
          const brewing = current.brews.filter((b) => b.date === date);
          const done = actuals.filter((a) => actualDate(a) === date);
          const sent = shipments.filter((s) => s.date === date);
          return (
            <article
              className={date === today ? "bp-day bp-day-today" : "bp-day"}
              key={date}
            >
              <h3>
                {day}
                {date === today ? " · היום" : ""}
                <small>
                  <bdi>{shortDate(date)}</bdi>
                </small>
              </h3>
              {holidays
                .filter((h) => h.date === date)
                .map((h) => (
                  <p className="bp-holiday" key={h.title}>
                    {h.title}
                  </p>
                ))}
              {(current.deliveryDates ?? []).includes(date) && (
                <p>נקבע איסוף לטמפו</p>
              )}
              {packs.map((r, index) => {
                const gap = workspace.forecast.points.find(
                  (p) =>
                    p.productId !== r.productId &&
                    p.date >= date &&
                    p.date <= addDays(date, 35) &&
                    (p.shortage ?? 0) > 0 &&
                    !(current.dismissedRecommendations ?? []).includes(
                      `hint:${date}:${p.productId}`,
                    ),
                );
                return (
                  <div className="bp-decision" key={r.id ?? index}>
                    <small>נקבע · אריזה</small>
                    <b>
                      {name(r.productId)} · {r.quantity}
                    </b>
                    <small>
                      מיכל{" "}
                      {tanks.find((t) => t.id === r.tankId)?.number ??
                        r.tankNumber ??
                        r.tankId ??
                        "טרם שויך"}
                    </small>
                    {gap && (
                      <div className="bp-adjustment">
                        <small>
                          ＊ כדאי לבדוק הקדמת {name(gap.productId)}: חוסר צפוי
                          ב־<bdi>{shortDate(gap.date)}</bdi>.
                        </small>
                        <button
                          disabled={disabled || busy || !!draft}
                          onClick={() => hide(`hint:${date}:${gap.productId}`)}
                        >
                          הסתרת ההערה ליום הזה
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {brewing.map((b) => (
                <div className="bp-decision" key={b.id}>
                  <small>נקבע · בישול</small>
                  <b>
                    {b.style} · {b.liters} ל׳
                  </b>
                  <small>
                    מיכל{" "}
                    {brews.find((t) => t.id === b.tankId)?.tankNumber ??
                      b.tankId}
                  </small>
                </div>
              ))}
              {deliveries.map((d) => (
                <div className="bp-decision" key={d.id}>
                  <small>
                    {d.id.startsWith("marked:")
                      ? "מיועד למשלוח · ממפת המקרר"
                      : "נקבע · משלוח"}
                  </small>
                  <b>
                    {name(d.productId)} · {d.quantity}
                  </b>
                </div>
              ))}
              {done.map((a) => (
                <div className="bp-completed" key={a.id}>
                  <small>בוצע · אריזה</small>
                  <b>
                    {a.beerStyle} · {a.quantity}{" "}
                    {a.unit ??
                      (a.packagingType === "kegs" ? "חביות" : "ארגזים")}
                  </b>
                </div>
              ))}
              {sent.map((s) => (
                <div className="bp-completed" key={s.id}>
                  בוצע · תעודת משלוח
                </div>
              ))}
              {recommendations.map((a) => {
                const style =
                  a.kind === "brew"
                    ? a.style
                    : (settings.products.find((p) => p.id === a.productId)
                        ?.style ?? "");
                return (
                  <div className="bp-recommendation" key={a.id}>
                    <span className={beerStyleClass(style).className}>
                      מומלץ ·{" "}
                      {a.kind === "brew"
                        ? "בישול"
                        : a.kind === "packaging"
                          ? "אריזה"
                          : "משלוח"}
                    </span>
                    <b>
                      {a.kind === "brew"
                        ? `${a.style} · ${a.liters} ל׳`
                        : `${name(a.productId)} · ${a.quantity}`}
                    </b>
                    {a.kind === "packaging" && (
                      <small>
                        {a.allocations
                          .map((t) => `מיכל ${t.number}`)
                          .join(", ")}
                      </small>
                    )}
                    {a.kind === "brew" && (
                      <small>
                        מיכל{" "}
                        {brews.find((t) => t.id === a.tankId)?.tankNumber ??
                          a.tankId}
                        {a.dependent ? " · לאחר ריקון וניקיון" : ""}
                      </small>
                    )}
                    <small>{a.reason}</small>
                    <div className="bp-actions">
                      <button
                        disabled={disabled || busy || !!draft}
                        onClick={() => editAction(a)}
                      >
                        קבלה / שינוי
                      </button>
                      <button
                        disabled={disabled || busy || !!draft}
                        onClick={() => hide(a.id)}
                      >
                        לא להציע ביום הזה
                      </button>
                    </div>
                  </div>
                );
              })}
              {!recommendations.length &&
                !packs.length &&
                !brewing.length &&
                !deliveries.length &&
                !done.length &&
                !sent.length && (
                  <p className="bp-muted">
                    {date < today
                      ? "לא התקבל דיווח"
                      : i === 4
                        ? "ניקיון והכנת מיכלים"
                        : i > 4
                          ? "ללא פעילות משובצת"
                          : "אין פעולה ישימה לפי המלאי והמיכלים כעת"}
                  </p>
                )}
            </article>
          );
        })}
      </div>
      <details>
        <summary>משטחים לליקוט בהמלצות השבוע</summary>
        <TruckRecommendations
          suggestions={actions.filter(
            (
              a,
            ): a is Extract<
              PlanningAction,
              { kind: "delivery" | "packaging" }
            > => a.kind !== "brew",
          )}
          disabled={disabled || !!draft}
        />
      </details>
      {(current.dismissedRecommendations ?? []).length > 0 && (
        <details>
          <summary>המלצות שהוסתרו בשבוע הזה</summary>
          <p>
            {current.dismissedRecommendations?.length} המלצות אינן מוצעות שוב
            בתאריכים האלה.
          </p>
          <button
            disabled={disabled || busy || !!draft}
            onClick={async () => {
              setBusy(true);
              try {
                await saveWeek({
                  ...current,
                  dismissedRecommendations: [],
                  changeReason: "החזרת המלצות שהוסתרו",
                });
              } catch (e) {
                setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
              } finally {
                setBusy(false);
              }
            }}
          >
            חישוב מחדש של ההמלצות שהוסתרו
          </button>
        </details>
      )}
      <details>
        <summary>בדיקת התחזית והנתונים</summary>
        {workspace.forecast.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
        {settings.products
          .filter((p) => p.monthly > 0)
          .map((p) => {
            const shortage = workspace.forecast.points.find(
              (x) => x.productId === p.id && (x.shortage ?? 0) > 0,
            );
            return shortage ? (
              <p key={p.id}>
                כדאי לבדוק הקדמת אספקה של {name(p.id)}: חוסר צפוי ב־
                <bdi>{shortDate(shortage.date)}</bdi>, גם לאחר ההמלצות.
              </p>
            ) : null;
          })}
      </details>
    </section>
  );
}
