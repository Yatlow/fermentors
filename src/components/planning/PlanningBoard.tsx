import { useState } from "react";
import type { Fermentor } from "../../App";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
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
import {
  actionImpact,
  tankDiagnostics,
  weekIsClosed,
} from "../../SERVICES/planning/planningPresentation";
import PlanningDaySelect from "./PlanningDaySelect";
import type { ProductionNeed } from "../../SERVICES/planning/productionNeeds";
import { packagingLimit } from "../../SERVICES/planning/productionCycle";
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
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [pickupDay, setPickupDay] = useState("");
  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
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
    if (weekIsClosed(next.id))
      throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
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
    setEditingDay(null);
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
    setDraft(adoptAction(effective, action));
    setEditingDay(action.date);
  }
  function editNeed(need: ProductionNeed) {
    const candidate =
      need.nextTank &&
      !need.nextTank.reserved &&
      need.nextTank.firstDay < addDays(weekStart(today), 84)
        ? need.nextTank
        : undefined;
    const date = candidate?.firstDay ?? need.date;
    const id = weekStart(date);
    const next = structuredClone(
      workspace.effectivePlans.find((w) => w.id === id) ?? {
        ...emptyWeek(id),
        maxRuns: settings.preferredRuns,
      },
    );
    next.dismissedRecommendations = [
      ...new Set([...(next.dismissedRecommendations ?? []), need.id]),
    ];
    if (need.kind === "brew")
      next.brews.push({
        id: crypto.randomUUID(),
        style: need.style,
        tankId: candidate?.id ?? "",
        date,
        liters: Math.min(need.quantity, candidate?.liters ?? need.quantity),
      });
    else {
      const product = settings.products.find((p) => p.id === need.productId)!;
      const step = product.type === "crates" ? 84 : 1;
      const available = candidate
        ? Math.floor(candidate.liters / litersPerUnit(product) / step) * step
        : need.quantity;
      next.packaging.push({
        id: crypto.randomUUID(),
        productId: product.id,
        tankId: candidate?.id ?? "",
        quantity: Math.min(
          need.quantity,
          available,
          packagingLimit(date, product.type),
        ),
        date,
        source: "manual",
      });
    }
    setWeek(id);
    setEditingDay(date);
    setDraft(next);
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
        <label>
          שבועות קודמים
          <select
            aria-label="שבועות קודמים"
            value={week < weekStart(today) ? week : ""}
            disabled={!!draft}
            onChange={(e) => {
              if (e.target.value) {
                setWeek(e.target.value);
                setPickupDay("");
              }
            }}
          >
            <option value="">בחירת שבוע לצפייה</option>
            {Array.from({ length: 12 }, (_, i) =>
              addDays(weekStart(today), -(i + 1) * 7),
            ).map((w) => (
              <option key={w} value={w}>
                שבוע {weekNumber(w)} · {shortDate(w)}
              </option>
            ))}
          </select>
        </label>
        {Array.from({ length: horizon }, (_, i) =>
          addDays(weekStart(today), i * 7),
        ).map((w) => (
          <button
            key={w}
            aria-pressed={week === w}
            disabled={!!draft}
            onClick={() => {
              setWeek(w);
              setPickupDay("");
            }}
          >
            שבוע {weekNumber(w)}
            <small>
              <bdi>{shortDate(w)}</bdi>
            </small>
          </button>
        ))}
      </div>
      {closed && (
        <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>
      )}
      {!closed && (
        <div className="bp-actions">
          <PlanningDaySelect
            week={week}
            value={pickupDay}
            onChange={setPickupDay}
            label="הוספת יום איסוף לטמפו"
          />
          <button
            disabled={readOnly || busy || !!draft || !pickupDay}
            onClick={() => {
              setEditingDay(pickupDay);
              setDraft({
                ...structuredClone(effective),
                deliveryDates: [
                  ...new Set([...(effective.deliveryDates ?? []), pickupDay]),
                ].sort(),
              });
            }}
          >
            הוספה ללוח
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
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
              className={[
                "bp-day",
                date === today ? "bp-day-today" : "",
                editingDay === date && draft ? "bp-day-editing" : "",
              ].join(" ")}
              key={date}
            >
              <h3>
                {day}
                {date === today ? " · היום" : ""}
                <small>
                  <bdi>{shortDate(date)}</bdi>
                </small>
              </h3>
              {!closed && (
                <button
                  disabled={readOnly || busy || !!draft}
                  onClick={() => {
                    setEditingDay(date);
                    setDraft(structuredClone(effective));
                  }}
                >
                  עריכת היום / הוספת פעולה
                </button>
              )}
              {editingDay === date && draft && (
                <PlanningWeekEditor
                  key={date}
                  day={date}
                  initial={draft}
                  settings={settings}
                  tanks={futureTanks(tanks, workspace.scenario, settings)}
                  brews={brews}
                  disabled={readOnly || busy}
                  onSave={persist}
                  onCancel={() => {
                    setDraft(null);
                    setEditingDay(null);
                  }}
                />
              )}
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
                          disabled={readOnly || busy || !!draft}
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
              {!!deliveries.length && (
                <div className="bp-decision">
                  <small>מיועד למשלוח · סה״כ ליום</small>
                  <b>
                    {(["crates", "kegs"] as const)
                      .map((type) => {
                        const total = deliveries
                          .filter(
                            (d) =>
                              settings.products.find(
                                (p) => p.id === d.productId,
                              )?.type === type,
                          )
                          .reduce((sum, d) => sum + d.quantity, 0);
                        return total
                          ? `${total.toLocaleString("he-IL")} ${type === "crates" ? "ארגזים" : "חביות"}`
                          : "";
                      })
                      .filter(Boolean)
                      .join(" + ")}
                  </b>
                  <details>
                    <summary>תכולת המשלוח</summary>
                    {deliveries.map((d) => (
                      <p key={d.id}>
                        {name(d.productId)} · {d.quantity}
                        <small>
                          {d.id.startsWith("marked:") ? "ממפת המקרר" : "החלטה"}
                        </small>
                      </p>
                    ))}
                  </details>
                </div>
              )}
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
                    <p className="bp-impact">
                      {actionImpact(
                        a,
                        settings,
                        today,
                        workspace.forecast.points,
                      )}
                    </p>
                    <details>
                      <summary>למה הפעולה מומלצת?</summary>
                      <small>{a.reason}</small>
                    </details>
                    <div className="bp-actions">
                      <button
                        disabled={readOnly || busy || !!draft}
                        onClick={() => editAction(a)}
                      >
                        קבלה / שינוי
                      </button>
                      <button
                        disabled={readOnly || busy || !!draft}
                        onClick={() => hide(a.id)}
                      >
                        לא להציע ביום הזה
                      </button>
                    </div>
                  </div>
                );
              })}
              {workspace.needs
                .filter((n) => n.date === date)
                .map((need) => (
                  <div className="bp-recommendation" key={need.id}>
                    <span className={beerStyleClass(need.style).className}>
                      המלצה · {need.kind === "brew" ? "בישול" : "אריזה"} · נדרש
                      פתרון
                    </span>
                    <b>
                      {need.style} · {need.quantity.toLocaleString("he-IL")}{" "}
                      {need.unit}
                    </b>
                    <p className="bp-impact">{need.reason}</p>
                    <p>{need.problem}</p>
                    {need.neededBy !== date && (
                      <small>
                        המועד הרצוי לפי הביקוש:{" "}
                        <bdi>{shortDate(need.neededBy)}</bdi>
                      </small>
                    )}
                    {need.nextTank ? (
                      <div>
                        <strong>המיכל הבא: {need.nextTank.number}</strong>
                        <small>
                          {need.kind === "packaging"
                            ? "בשל לאריזה החל מ־"
                            : "זמינות לאחר ריקון וניקיון"}{" "}
                          <bdi>{shortDate(need.nextTank.ready)}</bdi>
                        </small>
                        {!need.nextTank.reserved && (
                          <small>
                            יום עבודה ראשון מוצע:{" "}
                            <bdi>{shortDate(need.nextTank.firstDay)}</bdi> ·
                            בכפוף לשיבוצים
                          </small>
                        )}
                      </div>
                    ) : (
                      <small>אין כרגע מיכל עם תאריך זמינות ידוע.</small>
                    )}
                    <div className="bp-actions">
                      <button
                        disabled={readOnly || busy || !!draft}
                        onClick={() => editNeed(need)}
                      >
                        פתרון ושיבוץ
                      </button>
                      <button
                        disabled={readOnly || busy || !!draft}
                        onClick={() => hide(need.id)}
                      >
                        לא להציע ביום הזה
                      </button>
                    </div>
                  </div>
                ))}
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
          disabled={readOnly || !!draft}
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
            disabled={readOnly || busy || !!draft}
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
        <summary>חוסרים שעדיין דורשים טיפול</summary>
        <p>
          התחזית מניחה שגם ההמלצות בלוח יבוצעו. כאן מופיעים מוצרים שעדיין צפויים
          להיגמר בטמפו.
        </p>
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
      <details>
        <summary>מצב כל המיכלים · למה מיכל זמין או לא זמין לאריזה?</summary>
        <div className="bp-table-scroll">
          <table className="bp-stock-table">
            <thead>
              <tr>
                <th>מיכל</th>
                <th>בירה</th>
                <th>יתרה משוערת, ל׳</th>
                <th>מצב</th>
              </tr>
            </thead>
            <tbody>
              {tankDiagnostics(brews, tanks, today).map((t) => (
                <tr key={t.id}>
                  <td>{t.number}</td>
                  <td>{t.style}</td>
                  <td>
                    {t.liters === null
                      ? "—"
                      : Math.floor(t.liters).toLocaleString("he-IL")}
                  </td>
                  <td>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
