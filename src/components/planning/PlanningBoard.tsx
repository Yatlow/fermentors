import BeerLoader from "../general/Loading";
import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { addDays, emptyWeek, sameStyle, weekStart, weekNumber, type Actual, type BrewPlan, type Holiday, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { futureTanks, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { tankReleases, validateProduction, validateBrewReleases } from "../../SERVICES/planning/productionCycle";
import { validatePlanningWeek } from "../../SERVICES/planning/planningValidation";
import { displayStyle, weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import PlanningWeekEditor from "./PlanningWeekEditor";
import PlanningBrewAssignmentEditor from "./PlanningBrewAssignmentEditor";
import PlanningWeekGantt from "./PlanningWeekGantt";

type BrewWithAssignment = BrewPlan & {
  tankAssignmentStatus?: "tentative" | "confirmed";
  batchNumber?: string;
};

function assignmentStatus(brew: BrewPlan) {
  return (brew as BrewWithAssignment).tankAssignmentStatus;
}

function plannedBatch(brew: BrewPlan) {
  return (brew as BrewWithAssignment).batchNumber;
}

function forecastDateUndatedPackaging(plans: WeekPlan[]) {
  return plans.map((w) => ({
    ...w,
    packaging: w.packaging.map((r) => r.date ? r : { ...r, date: addDays(w.id, 4) }),
  }));
}

function confirmAssignedBrews(plan: WeekPlan): WeekPlan {
  return {
    ...plan,
    brews: plan.brews.map((brew) => brew.tankId
      ? { ...brew, tankAssignmentStatus: "confirmed" as const }
      : brew),
  };
}

export default function PlanningBoard({ settings, plans, tanks, brews, pallets, actuals, shipments: _shipments, today, holidays: _holidays, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; brews: Fermentor[]; pallets: Pallet[]; actuals: Actual[];
  shipments: ShipmentEvent[]; today: string; holidays: Holiday[]; disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const pickerStart = weekStart(today);
  const defaultPlanningWeek = addDays(pickerStart, 7);
  const [week, setWeek] = useState(defaultPlanningWeek);
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
  const reservedOutsideWeek = useMemo(() => new Set(
    plans
      .filter((w) => w.id !== week)
      .flatMap((w) => w.brews)
      .filter((b) => !!b.tankId && b.date >= today)
      .map((b) => b.tankId),
  ), [plans, week, today]);
  const releases = useMemo(
    () => tankReleases(brews, tanks, releasePlans, settings, actuals, today)
      .filter((release) => !reservedOutsideWeek.has(release.tankId)),
    [brews, tanks, releasePlans, settings, actuals, today, reservedOutsideWeek],
  );
  const productLabel = (id: string) => {
    const p = settings.products.find((x) => x.id === id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };

  const shipmentSummary = (current.deliveries ?? []).map((d) => `${productLabel(d.productId)} · ${Math.round(d.quantity)}`);
  const brewSummary = current.brews.map((b) => {
    if (!b.tankId) return `${displayStyle(b.style)} · ${Math.round(b.liters)} ל׳ · טרם שובץ למיכל`;
    const source = brews.find((t) => t.id === b.tankId);
    const tankNumber = source?.tankNumber ?? b.tankId;
    const batch = plannedBatch(b);
    const started = Number(source?.action) === 1 && (
      (batch && String(source?.batchNumber) === batch) ||
      (!batch && b.date <= today && sameStyle(source?.beerStyle ?? "", b.style))
    );
    if (started) {
      return `${displayStyle(b.style)} · מיכל ${tankNumber} · בוצע${source?.batchNumber ? ` · אצווה ${source.batchNumber}` : ""}`;
    }
    const status = assignmentStatus(b) === "tentative" ? "מוצע" : "מאושר";
    return `${displayStyle(b.style)} · ${Math.round(b.liters)} ל׳ · מיכל ${tankNumber} (${status})${batch ? ` · אצווה ${batch}` : ""}`;
  });
  const packagingSummary = current.packaging.map((p) => `${productLabel(p.productId)} · ${Math.round(p.quantity)} · מיכל ${tanks.find((t) => t.id === p.tankId)?.number ?? p.tankNumber ?? "?"}${p.date ? ` · ${shortDate(p.date)}` : " · טרם שובץ ליום"}`);
  const pendingPackaging = current.packaging.filter((p) => p.quantity > 0 && !p.date);

  async function persist(next: WeekPlan, confirmBrews = false) {
    if (weekIsClosed(next.id, today)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const effectiveNext = confirmBrews ? confirmAssignedBrews(next) : next;
    const all = [...plans.filter((w) => w.id !== effectiveNext.id), effectiveNext];
    const error = validatePlanningWeek(effectiveNext, settings, all, today);
    if (error) throw new Error(error);

    const datedOnly = all.map((w) => ({ ...w, packaging: w.packaging.filter((r) => !!r.date) }));
    const production = validateProduction(datedOnly, settings, futureTanks(tanks, all, settings), actuals, today);
    if (production) throw new Error(production);

    const assignedOnly = forecastDateUndatedPackaging(all).map((w) => ({ ...w, brews: w.brews.filter((b) => !!b.tankId) }));
    const dependency = validateBrewReleases(brews, tanks, assignedOnly, settings, actuals, today);
    if (dependency) throw new Error(dependency);

    await saveWeek(effectiveNext);
    setDraft(null); setEditingDay(null); setSelectedPackaging(null);
    setMessage(confirmBrews ? "סדר הבישולים ושיבוצי המיכלים אושרו" : "לוח העבודה נשמר");
  }

  function openDay(date: string) {
    if (readOnly) return;
    setEditingScope("day"); setEditingDay(date); setDraft(structuredClone(current));
  }

  function openBrews() {
    if (readOnly) return;
    setEditingScope("brews");
    setEditingDay(addDays(week, 1));
    setDraft(structuredClone(current));
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
    {busy && !draft && <BeerLoader overlay message="שומר את התכנון…" />}
    <div className="bp-section-heading"><div><h2>לוח עבודה</h2><p className="bp-muted">החלטות המשלוח והבישול הן שבועיות. האריזות משובצות ליום ביצוע.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(pickerStart, i * 7)).map((w) => <button key={w} aria-pressed={week === w} disabled={!!draft} onClick={() => { setWeek(w); setSelectedPackaging(null); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    <div className="bp-week-sticky" role="status"><b>עובדים על שבוע {weekNumber(week)}</b><span>{shortDate(week)}–{shortDate(addDays(week, 6))}</span><small>{week === defaultPlanningWeek ? "שבוע התכנון הבא" : "לוח עבודה"}</small></div>
    {closed && <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>}
    {message && <p role="status">{message}</p>}

    <div className="bp-daily-sets bp-weekly-execution-sets">
      <article className="bp-daily-set is-delivery">
        <h3>משלוח לטמפו · שבועי</h3>
        <div><b>החלטה ליישום</b>{shipmentSummary.length ? shipmentSummary.map((x, i) => <span key={i}>{x}</span>) : <small>לא נקבע משלוח</small>}</div>
      </article>

      <article className="bp-daily-set is-brew">
        <h3>בישולים · שבועי</h3>
        <div><b>החלטות ליישום</b>{brewSummary.length ? brewSummary.map((x, i) => <span key={i}>{x}</span>) : <small>לא נקבעו בישולים</small>}</div>
        <small>מנהל העבודה קובע רק את סדר הבישולים ואת המיכל. מספרי האצווה מתעדכנים אוטומטית לפי הסדר.</small>
        <button type="button" disabled={readOnly || current.brews.length === 0} onClick={openBrews}>סדר ושיבוץ בישולים</button>
      </article>

      <article className="bp-daily-set is-packaging">
        <h3>אריזות · יומי</h3>
        <div><b>החלטות השבוע</b>{packagingSummary.length ? packagingSummary.map((x, i) => <span key={i}>{x}</span>) : <small>לא נקבעו אריזות</small>}</div>
      </article>
    </div>

    {pendingPackaging.length > 0 && <div className="bp-pending-packaging" role="status">
      <div><strong>אריזות שממתינות לשיבוץ יום</strong><span className="bp-count-badge">{pendingPackaging.length}</span></div>
      <small>ההחלטה כבר קיימת; נשאר למנהל העבודה לבחור יום ביצוע.</small>
      <button type="button" disabled={readOnly} onClick={() => openDay(addDays(week, 1))}>שבץ אריזות לימים</button>
    </div>}

    <PlanningWeekGantt settings={settings} plans={plans} tanks={tanks} week={week} onSelectDate={openDay} selectedPackagingId={selectedPackaging} onSelectPackaging={selectPackaging}/>

    {editingDay && draft && <div className="bp-modal-backdrop" role="presentation"><div className="bp-modal bp-planning-scroll-modal" role="dialog" aria-modal="true" aria-label={editingScope === "brews" ? "שיבוץ בישולים למיכלים" : `עריכת ${shortDate(editingDay)}`}>
      {editingScope === "brews" ?
        <PlanningBrewAssignmentEditor
          initial={draft}
          brews={brews}
          releases={releases}
          disabled={readOnly || busy}
          onSave={async (next) => { setBusy(true); try { await persist(next, true); } finally { setBusy(false); } }}
          onCancel={() => { setDraft(null); setEditingDay(null); }}
        /> :
        <PlanningWeekEditor
          key={`day:${editingDay}`}
          day={editingDay}
          scope="day"
          initial={draft}
          settings={settings}
          tanks={tanks}
          releases={releases}
          brews={brews}
          pallets={pallets}
          disabled={readOnly || busy}
          onSave={async (next) => { setBusy(true); try { await persist(next); } finally { setBusy(false); } }}
          onCancel={() => { setDraft(null); setEditingDay(null); }}
        />}
    </div></div>}
  </section>;
}
