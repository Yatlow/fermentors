import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { addDays, emptyWeek, weekStart, weekNumber, type Actual, type Holiday, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { futureTanks, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { tankReleases, validateProduction, validateBrewReleases } from "../../SERVICES/planning/productionCycle";
import { validatePlanningWeek } from "../../SERVICES/planning/planningValidation";
import type { planningWorkspace } from "../../SERVICES/planning/workspace";
import { displayStyle, weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import PlanningWeekEditor from "./PlanningWeekEditor";
import PlanningWeekGantt from "./PlanningWeekGantt";
import PlanningDaySelect from "./PlanningDaySelect";
import "./planningV2.css";

type Workspace = ReturnType<typeof planningWorkspace>;

function activeWorkWeek(today: string) {
  const current = weekStart(today);
  return weekIsClosed(current, today) ? addDays(current, 7) : current;
}

function nextBrewDate(week: string, today: string) {
  for (let offset = 1; offset <= 4; offset++) {
    const date = addDays(week, offset);
    if (date >= today) return date;
  }
  return undefined;
}

function forecastDateUndatedPackaging(plans: WeekPlan[]) {
  return plans.map((w) => ({
    ...w,
    packaging: w.packaging.map((r) => r.date ? r : { ...r, date: addDays(w.id, 4) }),
  }));
}

export default function PlanningBoard({ settings, plans, tanks, brews, pallets, actuals, shipments: _shipments, today, holidays: _holidays, workspace, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; brews: Fermentor[]; pallets: Pallet[]; actuals: Actual[];
  shipments: ShipmentEvent[]; today: string; holidays: Holiday[]; workspace: Workspace; disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const startWeek = activeWorkWeek(today);
  const [week, setWeek] = useState(startWeek);
  const [draft, setDraft] = useState<WeekPlan | null>(null);
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [editingScope, setEditingScope] = useState<"day" | "brews">("day");
  const [selectedPackaging, setSelectedPackaging] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const releasePlans = useMemo(() => forecastDateUndatedPackaging(plans), [plans]);
  const releases = useMemo(
    () => tankReleases(brews, tanks, releasePlans, settings, actuals, today),
    [brews, tanks, releasePlans, settings, actuals, today],
  );
  const productLabel = (id: string) => {
    const p = settings.products.find((x) => x.id === id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };

  const shipmentDay = (current.deliveries ?? []).map((d) => d.dispatchDate).sort()[0] ?? "";
  const shipmentSummary = (current.deliveries ?? []).map((d) => `${productLabel(d.productId)} · ${Math.round(d.quantity)}`);
  const brewSummary = current.brews.map((b) => `${displayStyle(b.style)} · ${Math.round(b.liters)} ל׳ · ${b.tankId ? `מיכל ${brews.find((t) => t.id === b.tankId)?.tankNumber ?? b.tankId}` : "טרם שובץ למיכל"}`);
  const packagingSummary = current.packaging.map((p) => `${productLabel(p.productId)} · ${Math.round(p.quantity)} · מיכל ${tanks.find((t) => t.id === p.tankId)?.number ?? p.tankNumber ?? "?"}${p.date ? ` · ${shortDate(p.date)}` : " · טרם שובץ ליום"}`);

  async function persist(next: WeekPlan) {
    if (weekIsClosed(next.id, today)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const all = [...plans.filter((w) => w.id !== next.id), next];
    const error = validatePlanningWeek(next, settings, all, today);
    if (error) throw new Error(error);

    // Weekly decisions may intentionally be undated. Production validation only
    // validates runs that the work manager has actually placed on a day.
    const datedOnly = all.map((w) => ({ ...w, packaging: w.packaging.filter((r) => !!r.date) }));
    const production = validateProduction(datedOnly, settings, futureTanks(tanks, all, settings), actuals, today);
    if (production) throw new Error(production);

    const assignedOnly = forecastDateUndatedPackaging(all).map((w) => ({ ...w, brews: w.brews.filter((b) => !!b.tankId) }));
    const dependency = validateBrewReleases(brews, tanks, assignedOnly, settings, actuals, today);
    if (dependency) throw new Error(dependency);

    await saveWeek(next);
    setDraft(null); setEditingDay(null); setSelectedPackaging(null); setMessage("לוח העבודה נשמר");
  }

  function openDay(date: string) {
    if (readOnly) return;
    setEditingScope("day"); setEditingDay(date); setDraft(structuredClone(current));
  }
  function openBrews() {
    if (readOnly) return;
    setEditingScope("brews"); setEditingDay(nextBrewDate(week, today) ?? addDays(week, 1)); setDraft(structuredClone(current));
  }

  async function saveShipmentDay(date: string) {
    if (readOnly || busy || !(current.deliveries ?? []).length) return;
    const next = structuredClone(current);
    next.deliveries = (next.deliveries ?? []).map((d) => ({ ...d, dispatchDate: date, arrivalDate: date }));
    next.deliveryDates = date ? [date] : [];
    setBusy(true); setMessage("");
    try { await persist(next); setMessage(`יום המשלוח נקבע ל־${shortDate(date)}.`); }
    catch (e) { setMessage(e instanceof Error ? e.message : "שמירת יום המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  async function selectPackaging(id: string) {
    if (readOnly || busy) return;
    if (!selectedPackaging) { setSelectedPackaging(id); setMessage("בחר עכשיו אריזה שנייה כדי להחליף ביניהן את הימים."); return; }
    if (selectedPackaging === id) { setSelectedPackaging(null); setMessage(""); return; }
    const next = structuredClone(current);
    const first = next.packaging.find((p) => p.id === selectedPackaging);
    const second = next.packaging.find((p) => p.id === id);
    if (!first || !second || !first.date || !second.date) { setSelectedPackaging(null); return; }
    const date = first.date; first.date = second.date; second.date = date;
    setBusy(true);
    try { await persist(next); setMessage("ימי האריזה הוחלפו."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "ההחלפה נכשלה"); }
    finally { setBusy(false); setSelectedPackaging(null); }
  }

  return <section>
    <div className="bp-section-heading"><div><h2>לוח עבודה</h2><p className="bp-muted">החלטות המשלוח והבישול הן שבועיות. רק האריזות משובצות בטבלה היומית.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(startWeek, i * 7)).map((w) => <button key={w} aria-pressed={week === w} disabled={!!draft} onClick={() => { setWeek(w); setSelectedPackaging(null); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    <div className="bp-week-sticky"><b>שבוע {weekNumber(week)} · {shortDate(week)}–{shortDate(addDays(week, 6))}</b><small>לוח עבודה</small></div>
    {closed && <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>}
    {message && <p role="status">{message}</p>}

    <div className="bp-daily-sets bp-weekly-execution-sets">
      <article className="bp-daily-set is-delivery">
        <h3>משלוח לטמפו · שבועי</h3>
        <div><b>החלטה ליישום</b>{shipmentSummary.length ? shipmentSummary.map((x, i) => <span key={i}>{x}</span>) : <small>לא נקבע משלוח</small>}</div>
        {(current.deliveries ?? []).length > 0 && <PlanningDaySelect week={week} value={shipmentDay} onChange={saveShipmentDay} label="יום האיסוף היחיד השבוע"/>}
      </article>

      <article className="bp-daily-set is-brew">
        <h3>בישולים · שבועי</h3>
        <div><b>החלטות ליישום</b>{brewSummary.length ? brewSummary.map((x, i) => <span key={i}>{x}</span>) : <small>לא נקבעו בישולים</small>}</div>
        <small>ברירת המחדל לבישול היא שני–חמישי; מנהל העבודה יכול לשנות יום לכל בישול.</small>
        <button type="button" disabled={readOnly} onClick={openBrews}>שיבוץ בישולים למיכלים ולימים</button>
      </article>

      <article className="bp-daily-set is-packaging">
        <h3>אריזות · יומי</h3>
        <div><b>החלטות השבוע</b>{packagingSummary.length ? packagingSummary.map((x, i) => <span key={i}>{x}</span>) : <small>לא נקבעו אריזות</small>}</div>
      </article>
    </div>

    <PlanningWeekGantt settings={settings} plans={plans} tanks={tanks} week={week} onSelectDate={openDay} selectedPackagingId={selectedPackaging} onSelectPackaging={selectPackaging}/>

    {editingDay && draft && <div className="bp-modal-backdrop" role="presentation"><div className="bp-modal" role="dialog" aria-modal="true" aria-label={editingScope === "brews" ? "שיבוץ בישולים למיכלים" : `עריכת ${shortDate(editingDay)}`}>
      <PlanningWeekEditor key={`${editingScope}:${editingDay}`} day={editingDay} scope={editingScope} defaultBrewDate={nextBrewDate(week, today)} initial={draft} settings={settings} tanks={tanks} releases={releases} brews={brews} pallets={pallets} disabled={readOnly || busy} onSave={async (next) => { setBusy(true); try { await persist(next); } finally { setBusy(false); } }} onCancel={() => { setDraft(null); setEditingDay(null); }}/>
    </div></div>}
  </section>;
}
