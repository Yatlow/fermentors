import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { addDays, emptyWeek, weekStart, weekNumber, type Actual, type Holiday, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { futureTanks, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { validateProduction, validateBrewReleases } from "../../SERVICES/planning/productionCycle";
import { validatePlanningWeek } from "../../SERVICES/planning/planningValidation";
import type { planningWorkspace } from "../../SERVICES/planning/workspace";
import { displayStyle, weekIsClosed } from "../../SERVICES/planning/planningPresentation";
import PlanningWeekEditor from "./PlanningWeekEditor";
import PlanningWeekGantt from "./PlanningWeekGantt";
import "./planningV2.css";

type Workspace = ReturnType<typeof planningWorkspace>;

function nextBrewDate(week: string, today: string) {
  for (let offset = 1; offset <= 3; offset++) {
    const date = addDays(week, offset);
    if (date >= today) return date;
  }
  return undefined;
}

export default function PlanningBoard({ settings, plans, tanks, brews, pallets, actuals, shipments: _shipments, today, holidays: _holidays, workspace, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; brews: Fermentor[]; pallets: Pallet[]; actuals: Actual[];
  shipments: ShipmentEvent[]; today: string; holidays: Holiday[]; workspace: Workspace; disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [draft, setDraft] = useState<WeekPlan | null>(null);
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [editingScope, setEditingScope] = useState<"day" | "brews">("day");
  const [selectedPackaging, setSelectedPackaging] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const effective = workspace.effectivePlans.find((w) => w.id === week) ?? current;
  const actions = useMemo(() => workspace.actions.filter((a) => weekStart(a.date) === week), [workspace.actions, week]);
  const productLabel = (id: string) => {
    const p = settings.products.find((x) => x.id === id);
    return p ? `${displayStyle(p.style)} · ${p.type === "crates" ? "ארגזים" : "חביות"}` : id;
  };

  const summary = {
    delivery: {
      recommendations: actions.filter((a) => a.kind === "delivery").map((a) => a.kind === "delivery" ? `${productLabel(a.productId)} · ${Math.round(a.quantity)}` : ""),
      decisions: (current.deliveries ?? []).map((d) => `${productLabel(d.productId)} · ${Math.round(d.quantity)}`),
    },
    packaging: {
      recommendations: actions.filter((a) => a.kind === "packaging").map((a) => a.kind === "packaging" ? `${productLabel(a.productId)} · ${Math.round(a.quantity)} · מיכל ${a.allocations[0]?.number ?? "?"}` : ""),
      decisions: current.packaging.map((p) => `${productLabel(p.productId)} · ${Math.round(p.quantity)} · מיכל ${tanks.find((t) => t.id === p.tankId)?.number ?? p.tankNumber ?? "?"}`),
    },
    brew: {
      recommendations: actions.filter((a) => a.kind === "brew").map((a) => a.kind === "brew" ? `${displayStyle(a.style)} · ${Math.round(a.liters)} ל׳` : ""),
      decisions: current.brews.map((b) => `${displayStyle(b.style)} · ${Math.round(b.liters)} ל׳ · ${b.tankId ? `מיכל ${brews.find((t) => t.id === b.tankId)?.tankNumber ?? b.tankId}` : "טרם שובץ למיכל"}`),
    },
  };

  async function persist(next: WeekPlan) {
    if (weekIsClosed(next.id)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const all = [...plans.filter((w) => w.id !== next.id), next];
    const error = validatePlanningWeek(next, settings, all, today);
    if (error) throw new Error(error);
    const production = validateProduction(all, settings, futureTanks(tanks, workspace.scenario, settings), actuals, today);
    if (production) throw new Error(production);
    const assignedOnly = all.map((w) => ({ ...w, brews: w.brews.filter((b) => !!b.tankId) }));
    const dependency = validateBrewReleases(brews, tanks, assignedOnly, settings, actuals, today);
    if (dependency) throw new Error(dependency);
    await saveWeek(next);
    setDraft(null); setEditingDay(null); setSelectedPackaging(null); setMessage("לוח העבודה נשמר");
  }

  function openDay(date: string) {
    if (readOnly) return;
    setEditingScope("day"); setEditingDay(date); setDraft(structuredClone(effective));
  }
  function openBrews() {
    if (readOnly) return;
    setEditingScope("brews"); setEditingDay(nextBrewDate(week, today) ?? addDays(week, 1)); setDraft(structuredClone(effective));
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
    <div className="bp-section-heading"><div><h2>לוח עבודה יומי</h2><p className="bp-muted">המתכנן קובע את השבוע. כאן מנהל העבודה משבץ לימים ולמיכלים.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={week === w} disabled={!!draft} onClick={() => { setWeek(w); setSelectedPackaging(null); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    {closed && <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>}
    {message && <p role="status">{message}</p>}

    <div className="bp-daily-sets">
      <DailySet className="is-delivery" title="משלוח" recommendations={summary.delivery.recommendations} decisions={summary.delivery.decisions}/>
      <DailySet className="is-packaging" title="אריזה" recommendations={summary.packaging.recommendations} decisions={summary.packaging.decisions}/>
      <DailySet className="is-brew" title="בישול" recommendations={summary.brew.recommendations} decisions={summary.brew.decisions} actionLabel="שיבוץ בישולים למיכלים" onAction={openBrews}/>
    </div>

    <PlanningWeekGantt settings={settings} plans={plans} tanks={tanks} workspace={workspace} week={week} onSelectDate={openDay} selectedPackagingId={selectedPackaging} onSelectPackaging={selectPackaging}/>

    {editingDay && draft && <div className="bp-modal-backdrop" role="presentation"><div className="bp-modal" role="dialog" aria-modal="true" aria-label={editingScope === "brews" ? "שיבוץ בישולים למיכלים" : `עריכת ${shortDate(editingDay)}`}>
      <PlanningWeekEditor key={`${editingScope}:${editingDay}`} day={editingDay} scope={editingScope} defaultBrewDate={nextBrewDate(week, today)} initial={draft} settings={settings} tanks={futureTanks(tanks, workspace.scenario, settings)} brews={brews} pallets={pallets} disabled={readOnly || busy} onSave={async (next) => { setBusy(true); try { await persist(next); } finally { setBusy(false); } }} onCancel={() => { setDraft(null); setEditingDay(null); }}/>
    </div></div>}
  </section>;
}

function DailySet({ className, title, recommendations, decisions, actionLabel, onAction }: { className: string; title: string; recommendations: string[]; decisions: string[]; actionLabel?: string; onAction?: () => void }) {
  return <article className={`bp-daily-set ${className}`}><h3>{title}</h3><div><b>המלצות לידיעה</b>{recommendations.length ? recommendations.map((x, i) => <span key={i}>{x}</span>) : <small>אין המלצה נוספת</small>}</div><div><b>החלטות ליישום</b>{decisions.length ? decisions.map((x, i) => <span key={i}>{x}</span>) : <small>טרם נקבע</small>}</div>{onAction && <button type="button" onClick={onAction}>{actionLabel}</button>}</article>;
}
