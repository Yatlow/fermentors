import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { addDays, emptyWeek, litersPerUnit, weekStart, weekNumber, type Actual, type Holiday, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { actualDate, futureTanks, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { validateProduction, validateBrewReleases, packagingLimit, weekday } from "../../SERVICES/planning/productionCycle";
import { validatePlanningWeek } from "../../SERVICES/planning/planningValidation";
import { adoptAction, type PlanningAction, type planningWorkspace } from "../../SERVICES/planning/workspace";
import { weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import PlanningDaySelect from "./PlanningDaySelect";
import type { ProductionNeed } from "../../SERVICES/planning/productionNeeds";
import PlanningWeekEditor from "./PlanningWeekEditor";
import TruckRecommendations from "./TruckRecommendations";
import "./planningV2.css";

const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
type Workspace = ReturnType<typeof planningWorkspace>;
const kindLabel = (kind: PlanningAction["kind"]) => kind === "packaging" ? "אריזה" : kind === "delivery" ? "משלוח" : "בישול";

export default function PlanningBoard({ settings, plans, tanks, brews, actuals, shipments, today, holidays, workspace, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; brews: Fermentor[]; actuals: Actual[];
  shipments: ShipmentEvent[]; today: string; holidays: Holiday[]; workspace: Workspace;
  disabled: boolean; saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [horizon, setHorizon] = useState(4);
  const [draft, setDraft] = useState<WeekPlan | null>(null);
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [pickupDay, setPickupDay] = useState("");
  const [recommendationIndex, setRecommendationIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const effective = workspace.effectivePlans.find((w) => w.id === week) ?? current;
  const actions = useMemo(() => workspace.actions.filter((a) => weekStart(a.date) === week), [workspace.actions, week]);
  const weekNeeds = useMemo(() => workspace.needs.filter((n) => weekStart(n.date) === week), [workspace.needs, week]);
  const futureNeeds = workspace.needs.filter((n) => n.date > addDays(week, 6)).length;
  const recommendations = actions.filter((a) => a.kind !== "packaging" || !current.packaging.some((p) => p.date === a.date));
  const activeRecommendation = recommendations[Math.min(recommendationIndex, Math.max(0, recommendations.length - 1))];
  const name = (id: string) => { const p = settings.products.find((p) => p.id === id); return p ? `${p.style} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id; };

  async function persist(next: WeekPlan) {
    if (weekIsClosed(next.id)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const all = [...plans.filter((w) => w.id !== next.id), next];
    const error = validatePlanningWeek(next, settings, all, today); if (error) throw new Error(error);
    const production = validateProduction(all, settings, futureTanks(tanks, workspace.scenario, settings), actuals, today); if (production) throw new Error(production);
    const dependency = validateBrewReleases(brews, tanks, all, settings, actuals, today); if (dependency) throw new Error(dependency);
    await saveWeek(next); setDraft(null); setEditingDay(null); setMessage("ההחלטות נשמרו");
  }
  async function hide(id: string) {
    setBusy(true); setMessage("");
    try { await saveWeek({ ...current, dismissedRecommendations: [...new Set([...(current.dismissedRecommendations ?? []), id])], changeReason: "דילוג על המלצה" }); setRecommendationIndex(0); }
    catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); } finally { setBusy(false); }
  }
  function editAction(action: PlanningAction) {
    const targetWeek = weekStart(action.date); const base = workspace.effectivePlans.find((w) => w.id === targetWeek) ?? { ...emptyWeek(targetWeek), maxRuns: settings.preferredRuns };
    setWeek(targetWeek); setDraft(adoptAction(base, action)); setEditingDay(action.date);
  }
  function editNeed(need: ProductionNeed) {
    const candidate = need.nextTank && !need.nextTank.reserved && need.nextTank.firstDay < addDays(weekStart(today), 84) ? need.nextTank : undefined;
    const date = candidate?.firstDay ?? need.date; const id = weekStart(date);
    const next = structuredClone(workspace.effectivePlans.find((w) => w.id === id) ?? { ...emptyWeek(id), maxRuns: settings.preferredRuns });
    next.dismissedRecommendations = [...new Set([...(next.dismissedRecommendations ?? []), need.id])];
    if (need.kind === "brew") next.brews.push({ id: crypto.randomUUID(), style: need.style, tankId: candidate?.id ?? "", date, liters: Math.min(need.quantity, candidate?.liters ?? need.quantity) });
    else { const product = settings.products.find((p) => p.id === need.productId)!; const available = candidate ? Math.floor(candidate.liters / litersPerUnit(product)) : need.quantity; next.packaging.push({ id: crypto.randomUUID(), productId: product.id, tankId: candidate?.id ?? "", quantity: Math.max(1, Math.min(need.quantity, available, packagingLimit(date, product.type))), date, source: "manual" }); }
    setWeek(id); setEditingDay(date); setDraft(next);
  }

  return <section>
    <div className="bp-section-heading"><h2>לוח העבודה</h2><label>אופק<select value={horizon} onChange={(e) => { setHorizon(Number(e.target.value)); setWeek(weekStart(today)); }} disabled={!!draft}>{[4,8,12].map((n) => <option value={n} key={n}>{n} שבועות</option>)}</select></label></div>
    <p className="bp-muted">נקבע = החלטה שמורה · מומלץ = הצעה שטרם אושרה · דורש שיבוץ = צורך שעדיין אין לו מיכל/יום ישים.</p>
    <div className="bp-week-picker">{Array.from({ length: horizon }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={week === w} disabled={!!draft} onClick={() => { setWeek(w); setPickupDay(""); setRecommendationIndex(0); }}>שבוע {weekNumber(w)}<small><bdi>{shortDate(w)}</bdi></small></button>)}</div>
    {closed && <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>}
    {!closed && <div className="bp-actions"><PlanningDaySelect week={week} value={pickupDay} onChange={setPickupDay} label="יום איסוף לטמפו"/><button disabled={readOnly || busy || !!draft || !pickupDay || weekday(pickupDay) > 4} onClick={() => { setEditingDay(pickupDay); setDraft({ ...structuredClone(effective), deliveryDates: [...new Set([...(effective.deliveryDates ?? []), pickupDay])].sort() }); }}>הוספת איסוף</button></div>}
    {message && <p role="status">{message}</p>}

    <section className="bp-decision-queue"><div className="bp-section-heading"><div><h3>ההחלטה הבאה</h3><small>{recommendations.length ? `${Math.min(recommendationIndex + 1, recommendations.length)} מתוך ${recommendations.length}` : "אין המלצות פתוחות בשבוע"}</small></div>{recommendations.length > 1 && <div className="bp-actions"><button onClick={() => setRecommendationIndex((i) => Math.max(0, i - 1))}>הקודם</button><button onClick={() => setRecommendationIndex((i) => Math.min(recommendations.length - 1, i + 1))}>הבא</button></div>}</div>
      {activeRecommendation && <article className="bp-recommendation bp-focus-recommendation"><small>מומלץ · {kindLabel(activeRecommendation.kind)} · {shortDate(activeRecommendation.date)}</small><b>{activeRecommendation.kind === "brew" ? `${activeRecommendation.style} · ${activeRecommendation.liters} ל׳` : `${name(activeRecommendation.productId)} · ${activeRecommendation.quantity}`}</b>{activeRecommendation.kind === "packaging" && <small>מיכל {activeRecommendation.allocations[0]?.number ?? "טרם שויך"}</small>}<div className="bp-actions"><button disabled={readOnly || busy} onClick={() => editAction(activeRecommendation)}>קבלה / שינוי</button><button disabled={readOnly || busy} onClick={() => hide(activeRecommendation.id)}>דלג</button></div></article>}
    </section>

    {weekNeeds.length > 0 && <details className="bp-needs"><summary>דורש שיבוץ השבוע · {weekNeeds.length}</summary>{weekNeeds.map((n) => <div className="bp-plan-line" key={n.id}><b>{n.style} · {n.kind === "brew" ? "בישול" : "אריזה"}</b><span>{n.quantity} {n.unit} · {shortDate(n.date)}</span><button disabled={readOnly || busy} onClick={() => editNeed(n)}>שיבוץ / עריכה</button></div>)}</details>}
    {futureNeeds > 0 && <small className="bp-muted">עוד {futureNeeds} צרכים נמצאים בשבועות הבאים ואינם מוצגים כאן.</small>}

    <div className="bp-calendar">{days.map((day, i) => {
      const date = addDays(week, i); const weekend = i >= 5;
      const packs = current.packaging.filter((r) => r.date === date); const brewing = current.brews.filter((b) => b.date === date); const deliveries = (effective.deliveries ?? []).filter((d) => d.dispatchDate === date); const done = actuals.filter((a) => actualDate(a) === date); const sent = shipments.filter((s) => s.date === date);
      return <article className={`bp-day ${date === today ? "bp-day-today" : ""}`} key={date}><h3>{day}{date === today ? " · היום" : ""}<small>{shortDate(date)}</small></h3>
        {!closed && !weekend && <button disabled={readOnly || busy || !!draft} onClick={() => { setEditingDay(date); setDraft(structuredClone(effective)); }}>עריכת היום / הוספת פעולה</button>}
        {holidays.filter((h) => h.date === date).map((h) => <p className="bp-holiday" key={h.title}>{h.title}</p>)}{(current.deliveryDates ?? []).includes(date) && <p>נקבע איסוף לטמפו</p>}
        {packs.map((r, index) => <div className="bp-decision" key={r.id ?? index}><small>נקבע · אריזה</small><b>{name(r.productId)} · {r.quantity}</b><small>מיכל {tanks.find((t) => t.id === r.tankId)?.number ?? r.tankNumber ?? "טרם שויך"}</small></div>)}
        {brewing.map((b) => <div className="bp-decision" key={b.id}><small>נקבע · בישול</small><b>{b.style} · {b.liters} ל׳</b><small>מיכל {tanks.find((t) => t.id === b.tankId)?.number ?? b.tankId}</small></div>)}
        {deliveries.length > 0 && <div className="bp-decision"><small>נקבע · משלוח</small><b>{deliveries.reduce((s,d) => s + (d.pallets?.length ?? 0),0)} משטחים · {deliveries.length} מוצרים</b><span>{deliveries.map((d) => `${name(d.productId)} ${d.quantity}`).join(" · ")}</span></div>}
        {done.map((a) => <div className="bp-completed" key={a.id}><small>בוצע</small><b>{a.beerStyle ?? "אריזה"}</b></div>)}{sent.map((s, idx) => <div className="bp-completed" key={`${s.id}:${idx}`}><small>בוצע · משלוח</small><b>נשלח לטמפו</b></div>)}
      </article>;
    })}</div>
    <TruckRecommendations suggestions={workspace.forecast.suggestions.filter((s) => weekStart(s.date) === week)} disabled={readOnly}/>
    {editingDay && draft && <div className="bp-modal-backdrop" role="presentation"><div className="bp-modal" role="dialog" aria-modal="true" aria-label={`עריכת ${shortDate(editingDay)}`}><PlanningWeekEditor key={editingDay} day={editingDay} initial={draft} settings={settings} tanks={futureTanks(tanks, workspace.scenario, settings)} brews={brews} disabled={readOnly || busy} onSave={persist} onCancel={() => { setDraft(null); setEditingDay(null); }}/></div></div>}
  </section>;
}
