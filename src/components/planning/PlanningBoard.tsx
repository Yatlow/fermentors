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
  const [draft, setDraft] = useState<WeekPlan | null>(null);
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const closed = weekIsClosed(week, today);
  const readOnly = disabled || closed;
  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const effective = workspace.effectivePlans.find((w) => w.id === week) ?? current;
  const actions = useMemo(() => workspace.actions.filter((a) => weekStart(a.date) === week), [workspace.actions, week]);

  const summary = {
    delivery: {
      recommendations: actions.filter((a) => a.kind === "delivery").map((a) => a.kind === "delivery" ? `${displayStyle(settings.products.find((p) => p.id === a.productId)?.style ?? a.productId)} ${Math.round(a.quantity)}` : ""),
      decisions: (current.deliveries ?? []).map((d) => `${displayStyle(settings.products.find((p) => p.id === d.productId)?.style ?? d.productId)} ${Math.round(d.quantity)}`),
    },
    packaging: {
      recommendations: actions.filter((a) => a.kind === "packaging").map((a) => a.kind === "packaging" ? `${displayStyle(settings.products.find((p) => p.id === a.productId)?.style ?? a.productId)} ${Math.round(a.quantity)} · מיכל ${a.allocations[0]?.number ?? "?"}` : ""),
      decisions: current.packaging.map((p) => `${displayStyle(settings.products.find((x) => x.id === p.productId)?.style ?? p.productId)} ${Math.round(p.quantity)} · מיכל ${tanks.find((t) => t.id === p.tankId)?.number ?? p.tankNumber ?? "?"}`),
    },
    brew: {
      recommendations: actions.filter((a) => a.kind === "brew").map((a) => a.kind === "brew" ? `${displayStyle(a.style)} · מיכל ${brews.find((t) => t.id === a.tankId)?.tankNumber ?? a.tankId}` : ""),
      decisions: current.brews.map((b) => `${displayStyle(b.style)} · מיכל ${brews.find((t) => t.id === b.tankId)?.tankNumber ?? b.tankId}`),
    },
  };

  async function persist(next: WeekPlan) {
    if (weekIsClosed(next.id)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");
    const all = [...plans.filter((w) => w.id !== next.id), next];
    const error = validatePlanningWeek(next, settings, all, today);
    if (error) throw new Error(error);
    const production = validateProduction(all, settings, futureTanks(tanks, workspace.scenario, settings), actuals, today);
    if (production) throw new Error(production);
    const dependency = validateBrewReleases(brews, tanks, all, settings, actuals, today);
    if (dependency) throw new Error(dependency);
    await saveWeek(next);
    setDraft(null); setEditingDay(null); setMessage("לוח העבודה נשמר");
  }

  function openDay(date: string) {
    if (readOnly) return;
    setEditingDay(date);
    setDraft(structuredClone(effective));
  }

  return (
    <section>
      <div className="bp-section-heading"><div><h2>לוח עבודה יומי</h2><p className="bp-muted">ההחלטות השבועיות נקבעות על ידי המתכנן. כאן מנהל העבודה רק משבץ אותן לימים ומעדכן את הביצוע המתוכנן.</p></div></div>
      <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={week === w} disabled={!!draft} onClick={() => setWeek(w)}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
      {closed && <p role="status">השבוע הסתיים לתכנון בתחילת יום שישי · צפייה בלבד.</p>}
      {message && <p role="status">{message}</p>}

      <div className="bp-daily-sets">
        <DailySet className="is-delivery" title="משלוח" recommendations={summary.delivery.recommendations} decisions={summary.delivery.decisions}/>
        <DailySet className="is-packaging" title="אריזה" recommendations={summary.packaging.recommendations} decisions={summary.packaging.decisions}/>
        <DailySet className="is-brew" title="בישול" recommendations={summary.brew.recommendations} decisions={summary.brew.decisions}/>
      </div>

      <PlanningWeekGantt settings={settings} plans={plans} tanks={tanks} workspace={workspace} week={week} onSelectDate={openDay}/>

      {editingDay && draft && (
        <div className="bp-modal-backdrop" role="presentation">
          <div className="bp-modal" role="dialog" aria-modal="true" aria-label={`עריכת ${shortDate(editingDay)}`}>
            <PlanningWeekEditor
              key={editingDay}
              day={editingDay}
              scope="day"
              defaultBrewDate={nextBrewDate(week, today)}
              initial={draft}
              settings={settings}
              tanks={futureTanks(tanks, workspace.scenario, settings)}
              brews={brews}
              pallets={pallets}
              disabled={readOnly || busy}
              onSave={async (next) => { setBusy(true); try { await persist(next); } finally { setBusy(false); } }}
              onCancel={() => { setDraft(null); setEditingDay(null); }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function DailySet({ className, title, recommendations, decisions }: { className: string; title: string; recommendations: string[]; decisions: string[] }) {
  return <article className={`bp-daily-set ${className}`}><h3>{title}</h3><div><b>המלצות לידיעה</b>{recommendations.length ? recommendations.map((x, i) => <span key={i}>{x}</span>) : <small>אין המלצה נוספת</small>}</div><div><b>החלטות ליישום</b>{decisions.length ? decisions.map((x, i) => <span key={i}>{x}</span>) : <small>טרם נקבע</small>}</div></article>;
}
