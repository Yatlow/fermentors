import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import {
  addDays,
  emptyWeek,
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
  type ShipmentEvent,
} from "../../SERVICES/planning/dailyPlanner";
import {
  validateProduction,
  validateBrewReleases,
  weekday,
} from "../../SERVICES/planning/productionCycle";
import { validatePlanningWeek } from "../../SERVICES/planning/planningValidation";
import {
  adoptAction,
  type PlanningAction,
  type planningWorkspace,
} from "../../SERVICES/planning/workspace";
import { weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import PlanningDaySelect from "./PlanningDaySelect";
import PlanningWeekEditor from "./PlanningWeekEditor";
import TruckRecommendations from "./TruckRecommendations";
import "./planningV2.css";

const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
type Workspace = ReturnType<typeof planningWorkspace>;
const kindLabel = (kind: PlanningAction["kind"]) =>
  kind === "packaging" ? "אריזה" : kind === "delivery" ? "משלוח" : "בישול";

function nextBrewDate(week: string, today: string) {
  for (let offset = 1; offset <= 3; offset++) {
    const date = addDays(week, offset);
    if (date >= today) return date;
  }
  return undefined;
}

export default function PlanningBoard({
  settings,
  plans,
  tanks,
  brews,
  pallets,
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
  pallets: Pallet[];
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
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [editingScope, setEditingScope] = useState<"day" | "brews">("day");
  const [pickupDay, setPickupDay] = useState("");
  const [recommendationIndex, setRecommendationIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
  const current =
    plans.find((w) => w.id === week) ?? {
      ...emptyWeek(week),
      maxRuns: settings.preferredRuns,
    };
  const effective = workspace.effectivePlans.find((w) => w.id === week) ?? current;
  const actions = useMemo(
    () => workspace.actions.filter((a) => weekStart(a.date) === week),
    [workspace.actions, week],
  );
  const recommendations = actions.filter(
    (a) =>
      a.kind !== "packaging" ||
      !current.packaging.some((p) => p.date === a.date),
  );
  const activeRecommendation =
    recommendations[
      Math.min(recommendationIndex, Math.max(0, recommendations.length - 1))
    ];
  const name = (id: string) => {
    const p = settings.products.find((p) => p.id === id);
    return p
      ? `${p.style} · ${p.type === "crates" ? "ארגזים" : "חביות"}`
      : id;
  };
  const weeklyBrews = current.brews
    .filter((b) => weekStart(b.date) === week)
    .sort((a, b) => a.date.localeCompare(b.date));

  async function persist(next: WeekPlan) {
    if (weekIsClosed(next.id))
      throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const all = [...plans.filter((w) => w.id !== next.id), next];
    const error = validatePlanningWeek(next, settings, all, today);
    if (error) throw new Error(error);
    const production = validateProduction(
      all,
      settings,
      futureTanks(tanks, workspace.scenario, settings),
      actuals,
      today,
    );
    if (production) throw new Error(production);
    const dependency = validateBrewReleases(
      brews,
      tanks,
      all,
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
        changeReason: "דילוג על המלצה",
      });
      setRecommendationIndex(0);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  function editAction(action: PlanningAction) {
    const targetWeek = weekStart(action.date);
    const base =
      workspace.effectivePlans.find((w) => w.id === targetWeek) ?? {
        ...emptyWeek(targetWeek),
        maxRuns: settings.preferredRuns,
      };
    setWeek(targetWeek);
    setDraft(adoptAction(base, action));
    setEditingScope(action.kind === "brew" ? "brews" : "day");
    setEditingDay(action.date);
  }

  function openDay(date: string) {
    setEditingScope("day");
    setEditingDay(date);
    setDraft(structuredClone(effective));
  }

  function openBrews() {
    setEditingScope("brews");
    setEditingDay(nextBrewDate(week, today) ?? addDays(week, 1));
    setDraft(structuredClone(effective));
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

      <div className="bp-week-picker">
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
              setRecommendationIndex(0);
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
            label="יום איסוף לטמפו"
          />
          <button
            disabled={
              readOnly ||
              busy ||
              !!draft ||
              !pickupDay ||
              weekday(pickupDay) > 4
            }
            onClick={() => {
              setEditingScope("day");
              setEditingDay(pickupDay);
              setDraft({
                ...structuredClone(effective),
                deliveryDates: [
                  ...new Set([...(effective.deliveryDates ?? []), pickupDay]),
                ].sort(),
              });
            }}
          >
            הוספת איסוף
          </button>
        </div>
      )}

      {message && <p role="status">{message}</p>}

      <section className="bp-week-brews">
        <div className="bp-section-heading">
          <div>
            <h3>בישולים השבוע</h3>
            <small>בישול הוא החלטה שבועית; היום המדויק משמש רק את התחזית.</small>
          </div>
          {!closed && (
            <button disabled={readOnly || busy || !!draft} onClick={openBrews}>
              עריכת בישולים
            </button>
          )}
        </div>
        {weeklyBrews.length ? (
          <div className="bp-week-brew-list">
            {weeklyBrews.map((b) => (
              <div className="bp-decision" key={b.id}>
                <small>נקבע · בישול</small>
                <b>{b.style} · {Math.round(b.liters)} ל׳</b>
                <span>
                  מיכל {brews.find((t) => t.id === b.tankId)?.tankNumber ?? b.tankId}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="bp-muted">לא נקבע בישול לשבוע הזה.</p>
        )}
      </section>

      <section className="bp-decision-queue">
        <div className="bp-section-heading">
          <div>
            <h3>ההחלטה הבאה</h3>
            <small>
              {recommendations.length
                ? `${Math.min(recommendationIndex + 1, recommendations.length)} מתוך ${recommendations.length}`
                : "אין המלצות פתוחות בשבוע"}
            </small>
          </div>
          {recommendations.length > 1 && (
            <div className="bp-actions">
              <button
                onClick={() =>
                  setRecommendationIndex((i) => Math.max(0, i - 1))
                }
              >
                הקודם
              </button>
              <button
                onClick={() =>
                  setRecommendationIndex((i) =>
                    Math.min(recommendations.length - 1, i + 1),
                  )
                }
              >
                הבא
              </button>
            </div>
          )}
        </div>

        {activeRecommendation && (
          <article className="bp-recommendation bp-focus-recommendation">
            <small>
              מומלץ · {kindLabel(activeRecommendation.kind)} · {activeRecommendation.kind === "brew" ? `שבוע ${weekNumber(week)}` : shortDate(activeRecommendation.date)}
            </small>
            <b>
              {activeRecommendation.kind === "brew"
                ? `${activeRecommendation.style} · ${Math.round(activeRecommendation.liters)} ל׳`
                : `${name(activeRecommendation.productId)} · ${activeRecommendation.quantity}`}
            </b>
            {activeRecommendation.kind === "packaging" && (
              <small>
                מיכל {activeRecommendation.allocations[0]?.number ?? "טרם שויך"}
              </small>
            )}
            <div className="bp-actions">
              <button
                disabled={readOnly || busy}
                onClick={() => editAction(activeRecommendation)}
              >
                קבלה / שינוי
              </button>
              <button
                disabled={readOnly || busy}
                onClick={() => hide(activeRecommendation.id)}
              >
                דלג
              </button>
            </div>
          </article>
        )}
      </section>

      <div className="bp-calendar">
        {days.map((dayName, i) => {
          const date = addDays(week, i);
          const weekend = i >= 5;
          const packs = current.packaging.filter((r) => r.date === date);
          const deliveries = (effective.deliveries ?? []).filter(
            (d) => d.dispatchDate === date,
          );
          const done = actuals.filter((a) => actualDate(a) === date);
          const sent = shipments.filter((s) => s.date === date);
          return (
            <article
              className={`bp-day ${date === today ? "bp-day-today" : ""}`}
              key={date}
            >
              <h3>
                {dayName}
                {date === today ? " · היום" : ""}
                <small>{shortDate(date)}</small>
              </h3>
              {!closed && !weekend && (
                <button
                  disabled={readOnly || busy || !!draft}
                  onClick={() => openDay(date)}
                >
                  עריכת היום / הוספת פעולה
                </button>
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
              {packs.map((r, index) => (
                <div className="bp-decision" key={r.id ?? index}>
                  <small>נקבע · אריזה</small>
                  <b>{name(r.productId)} · {r.quantity}</b>
                  <small>
                    מיכל {tanks.find((t) => t.id === r.tankId)?.number ?? r.tankNumber ?? "טרם שויך"}
                  </small>
                </div>
              ))}
              {deliveries.length > 0 && (
                <div className="bp-decision">
                  <small>נקבע · משלוח</small>
                  <b>
                    {deliveries.reduce(
                      (s, d) => s + (d.pallets?.length ?? 0),
                      0,
                    )}{" "}
                    משטחים · {deliveries.length} מוצרים
                  </b>
                  <span>
                    {deliveries
                      .map((d) => `${name(d.productId)} ${d.quantity}`)
                      .join(" · ")}
                  </span>
                </div>
              )}
              {done.map((a) => (
                <div className="bp-completed" key={a.id}>
                  <small>בוצע</small>
                  <b>{a.beerStyle ?? "אריזה"}</b>
                </div>
              ))}
              {sent.map((s, idx) => (
                <div className="bp-completed" key={`${s.id}:${idx}`}>
                  <small>בוצע · משלוח</small>
                  <b>נשלח לטמפו</b>
                </div>
              ))}
            </article>
          );
        })}
      </div>

      <TruckRecommendations
        suggestions={workspace.forecast.suggestions.filter(
          (s) => weekStart(s.date) === week,
        )}
        disabled={readOnly}
      />

      {editingDay && draft && (
        <div className="bp-modal-backdrop" role="presentation">
          <div
            className="bp-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              editingScope === "brews"
                ? `בישולים שבוע ${weekNumber(week)}`
                : `עריכת ${shortDate(editingDay)}`
            }
          >
            <PlanningWeekEditor
              key={`${editingScope}:${editingDay}`}
              day={editingDay}
              scope={editingScope}
              defaultBrewDate={nextBrewDate(week, today)}
              initial={draft}
              settings={settings}
              tanks={futureTanks(tanks, workspace.scenario, settings)}
              brews={brews}
              pallets={pallets}
              disabled={readOnly || busy}
              onSave={persist}
              onCancel={() => {
                setDraft(null);
                setEditingDay(null);
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
