import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import {
  addDays,
  emptyWeek,
  sameStyle,
  weeklyDemand,
  weekNumber,
  weekStart,
  type DeliveryPlan,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { estimatedBrewVolume } from "../../SERVICES/planning/productionCycle";
import { CORE_STYLES, displayStyle, isCoreStyle } from "../../SERVICES/planning/planningPresentation";
import { adoptAction, type PlanningAction, type planningWorkspace } from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
type Kind = PlanningAction["kind"];
type BrewDraft = { style: string; tankId: string; liters: number };
const fmt = (n: number) => Math.round(n).toLocaleString("he-IL", { maximumFractionDigits: 0 });

export default function PlanningWeeklyRecommendations({
  settings, plans, tanks, sources, pallets, today, workspace, disabled, saveWeek,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  today: string;
  workspace: Workspace;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [editing, setEditing] = useState<Kind | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});
  const [brewDraft, setBrewDraft] = useState<Record<string, BrewDraft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const actions = useMemo(() => workspace.actions.filter((a) => weekStart(a.date) === week), [workspace.actions, week]);
  const product = (id: string) => settings.products.find((p) => p.id === id);
  const ship = actions.filter((a) => a.kind === "delivery");
  const pack = actions.filter((a) => a.kind === "packaging");
  const brew = actions.filter((a) => a.kind === "brew");

  const sourceNumber = (id: string) => sources.find((s) => s.id === id)?.tankNumber ?? tanks.find((t) => t.id === id)?.number ?? id;
  const coreProducts = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));

  const warnings = useMemo(() => {
    const result = workspace.needs
      .filter((n) => weekStart(n.date) === week)
      .map((n) => {
        const scheduled = n.kind === "packaging"
          ? current.packaging.filter((p) => p.productId === n.productId).reduce((sum, p) => sum + p.quantity, 0)
          : current.brews.filter((b) => sameStyle(b.style, n.style)).reduce((sum, b) => sum + b.liters, 0);
        const suffix = n.problem.includes("כבר מוקצה")
          ? "הכמות שכבר שובצה ממיכל זה אינה מספיקה לצורך המחושב."
          : n.problem;
        return `${displayStyle(n.style)}: נקבע ${fmt(scheduled)} ${n.kind === "brew" ? "ל׳" : n.unit}; עדיין חסרים כ־${fmt(n.quantity)} ${n.unit}. ${suffix}`;
      });
    return [...new Set(result)].slice(0, 6);
  }, [workspace.needs, week, current.packaging, current.brews]);

  const availableFor = (productId: string) => {
    const p = product(productId);
    if (!p) return { physicalPallets: 0, physicalQty: 0, plannedPallets: 0, plannedQty: 0 };
    const physical = pallets.filter((x) => x.zone !== "shipped" && x.itemType === p.type && sameStyle(x.beerStyle, p.style));
    const plannedQty = current.packaging.filter((x) => x.productId === p.id).reduce((sum, x) => sum + x.quantity, 0);
    return {
      physicalPallets: physical.length,
      physicalQty: physical.reduce((sum, x) => sum + x.quantity, 0),
      plannedPallets: plannedQty ? projectedPallets(p, plannedQty, `week:${week}`).length : 0,
      plannedQty,
    };
  };

  const shipmentRows = coreProducts.map((p) => {
    const recommendedQty = ship.filter((a) => a.kind === "delivery" && a.productId === p.id).reduce((s, a) => s + a.quantity, 0);
    const decidedQty = (current.deliveries ?? []).filter((d) => d.productId === p.id).reduce((s, d) => s + d.quantity, 0);
    const recPallets = recommendedQty ? projectedPallets(p, recommendedQty, `rec:${week}:${p.id}`).length : 0;
    const decidedPallets = decidedQty ? projectedPallets(p, decidedQty, `dec:${week}:${p.id}`).length : 0;
    const a = availableFor(p.id);
    const cover = p.tempo === null || weeklyDemand(p) <= 0 ? null : p.tempo / weeklyDemand(p);
    const severity = cover === null ? "neutral" : cover < 1 ? "critical" : cover < settings.targetWeeks ? "warning" : "ok";
    return { p, recommendedQty, decidedQty, recPallets, decidedPallets, availability: a, cover, severity };
  });

  const recommendedTruckSlots = useMemo(() => {
    const manifests = ship.flatMap((a) => a.kind === "delivery" ? (a.pallets ?? []) : []);
    if (!manifests.length) return 0;
    try { return calcTruckSlots(manifests); } catch { return 0; }
  }, [ship]);

  function decidedTruckSlots() {
    try {
      const manifest = (current.deliveries ?? []).flatMap((d) => {
        const p = product(d.productId);
        return p ? projectedPallets(p, d.quantity, d.id).map((x) => x.pallet) : [];
      });
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch { return 0; }
  }

  const packagingLines = pack.flatMap((action) => {
    if (action.kind !== "packaging") return [];
    const p = product(action.productId);
    if (!p) return [];
    const tankText = action.allocations.length ? `מיכל ${action.allocations.map((a) => a.number).join(", ")}` : "ללא מיכל ישים";
    return [{ action, p, text: `${displayStyle(p.style)} · ${fmt(action.quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"} · ${tankText}` }];
  });

  const brewingLines = brew.flatMap((action) => action.kind === "brew" ? [{ action }] : []);

  function startEdit(kind: Kind) {
    setEditing(kind); setMessage("");
    const qty: Record<string, number> = {};
    if (kind === "delivery") {
      for (const row of shipmentRows) qty[`ship:${row.p.id}`] = row.decidedQty || row.recommendedQty;
    } else if (kind === "packaging") {
      for (const r of current.packaging) qty[`saved:${r.id}`] = r.quantity;
      for (const a of pack) if (a.kind === "packaging") qty[`rec:${a.id}`] = a.quantity;
    } else {
      const drafts: Record<string, BrewDraft> = {};
      for (const b of current.brews) drafts[`saved:${b.id}`] = { style: b.style, tankId: b.tankId, liters: b.liters };
      for (const a of brew) if (a.kind === "brew") drafts[`rec:${a.id}`] = { style: a.style, tankId: a.tankId, liters: a.liters };
      setBrewDraft(drafts);
    }
    setDraftQty(qty);
  }

  async function saveEdited(kind: Kind) {
    setBusy(true); setMessage("");
    try {
      let next = structuredClone(current);
      if (kind === "delivery") {
        const date = (current.deliveries ?? [])[0]?.dispatchDate ?? ship.find((a) => a.kind === "delivery")?.date ?? addDays(week, 1);
        const deliveries: DeliveryPlan[] = [];
        for (const p of coreProducts) {
          const quantity = Math.max(0, Number(draftQty[`ship:${p.id}`] ?? 0));
          if (!quantity) continue;
          deliveries.push({ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${date}`, pallets: [] });
        }
        next.deliveries = deliveries;
        next.deliveryDates = deliveries.length ? [date] : [];
      } else if (kind === "packaging") {
        next.packaging = next.packaging.map((r) => ({ ...r, quantity: Math.max(0, Number(draftQty[`saved:${r.id}`] ?? r.quantity)) })).filter((r) => r.quantity > 0);
        for (const action of pack) {
          if (action.kind !== "packaging" || next.packaging.some((x) => x.id === action.id)) continue;
          const quantity = Math.max(0, Number(draftQty[`rec:${action.id}`] ?? 0));
          if (quantity > 0) next = adoptAction(next, { ...action, quantity });
        }
      } else {
        next.brews = next.brews.map((b) => {
          const d = brewDraft[`saved:${b.id}`];
          return d ? { ...b, ...d } : b;
        });
        for (const action of brew) {
          if (action.kind !== "brew" || next.brews.some((x) => x.id === action.id)) continue;
          const d = brewDraft[`rec:${action.id}`];
          if (d?.tankId && d.style && d.liters > 0) next = adoptAction(next, { ...action, ...d });
        }
      }
      next.changeReason = `עריכת החלטת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next);
      setEditing(null); setMessage("ההחלטה השבועית נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); }
    finally { setBusy(false); }
  }

  async function accept(kind: Kind) {
    const selected = actions.filter((a) => a.kind === kind);
    if (!selected.length) return;
    setBusy(true); setMessage("");
    try {
      let next = structuredClone(current);
      for (const action of selected) {
        const exists = action.kind === "brew" ? next.brews.some((x) => x.id === action.id) : action.kind === "packaging" ? next.packaging.some((x) => x.id === action.id) : (next.deliveries ?? []).some((x) => x.id === action.id);
        if (!exists) next = adoptAction(next, action);
      }
      next.changeReason = `אישור המלצת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next); setMessage("ההמלצה נשמרה כהחלטה שבועית.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); }
    finally { setBusy(false); }
  }

  return (
    <section className="bp-weekly-planner">
      <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">המתכנן מחליט כאן מה יקרה בשבוע. אין כאן שיבוץ לימים — זו משימה נפרדת של מנהל העבודה.</p></div></div>
      <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={week === w} onClick={() => { setWeek(w); setEditing(null); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
      {warnings.length > 0 && <div className="bp-week-alerts"><b>אזהרות לתוכנית</b>{warnings.map((w) => <span key={w}>⚠ {w}</span>)}</div>}

      <div className="bp-week-recommendations">
        <article className="bp-week-rec-card bp-week-shipment-card">
          <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{recommendedTruckSlots}/{MAX_TRUCK_SLOTS} מקומות</b></header>
          <p className="bp-rec-principle">משלוח רגיל מומלץ רק כשהוא ממלא 12/12 מקומות. בחירת המשטחים בפועל תיעשה אחר כך לפי FIFO.</p>
          <div className="bp-shipment-plan-table">
            <div className="bp-shipment-plan-head"><span>מקט</span><span>מומלץ</span><span>נקבע</span><span>זמין / בתכנון</span></div>
            {shipmentRows.map((row) => <div className={`bp-shipment-plan-row is-${row.severity}`} key={row.p.id}>
              <span><b>{displayStyle(row.p.style)}</b><small>{row.p.type === "crates" ? "ארגזים" : "חביות"}{row.cover === null ? "" : ` · ${row.cover.toFixed(1)} שב׳ בטמפו`}</small></span>
              <span>{row.recPallets} מש׳<small>{fmt(row.recommendedQty)}</small></span>
              <span>{editing === "delivery" ? <input type="number" min="0" value={draftQty[`ship:${row.p.id}`] ?? 0} onChange={(e) => setDraftQty((q) => ({ ...q, [`ship:${row.p.id}`]: Number(e.target.value) }))}/> : <>{row.decidedPallets} מש׳<small>{fmt(row.decidedQty)}</small></>}</span>
              <span>{row.availability.physicalPallets} מש׳<small>פיזי {fmt(row.availability.physicalQty)} · תכנון {row.availability.plannedPallets} מש׳ / {fmt(row.availability.plannedQty)}</small></span>
            </div>)}
          </div>
          <div className="bp-saved-summary">החלטה נוכחית: {decidedTruckSlots()}/{MAX_TRUCK_SLOTS} מקומות במשאית.</div>
          <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={() => saveEdited("delivery")}>שמירת החלטת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || recommendedTruckSlots < MAX_TRUCK_SLOTS} onClick={() => accept("delivery")}>קבל המלצה של 12/12</button><button disabled={disabled || busy} onClick={() => startEdit("delivery")}>עריכת ההמלצה / ההחלטה</button></>}</div>
        </article>

        <article className="bp-week-rec-card">
          <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{pack.length} המלצות</b></header>
          {current.packaging.length > 0 && <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.packaging.map((r) => { const p = product(r.productId); return <div className="bp-rec-line" key={r.id}><b>{p ? displayStyle(p.style) : r.productId} · {fmt(r.quantity)} {p?.type === "crates" ? "ארגזים" : "חביות"}</b><span>מיכל {tanks.find((t) => t.id === r.tankId)?.number ?? r.tankNumber ?? "?"}</span>{editing === "packaging" && <input type="number" min="0" value={draftQty[`saved:${r.id}`] ?? r.quantity} onChange={(e) => setDraftQty((q) => ({ ...q, [`saved:${r.id}`]: Number(e.target.value) }))}/>}</div>; })}</div>}
          <div className="bp-decided-list"><b>המלצות לידיעה</b>{packagingLines.length ? packagingLines.map((line) => <div className="bp-rec-line" key={line.action.id}><b>{line.text}</b><span>{line.action.reason}</span>{editing === "packaging" && !current.packaging.some((x) => x.id === line.action.id) && <input type="number" min="0" value={draftQty[`rec:${line.action.id}`] ?? line.action.quantity} onChange={(e) => setDraftQty((q) => ({ ...q, [`rec:${line.action.id}`]: Number(e.target.value) }))}/>}</div>) : <p className="bp-muted">אין המלצת אריזה נוספת.</p>}</div>
          <p className="bp-rec-principle">ברירת המחדל היא לרוקן מיכל באותו שבוע; אם עדיף פיצול, ההמלצה חייבת לציין זאת במפורש.</p>
          <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={() => saveEdited("packaging")}>שמירת החלטת האריזה</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !pack.length} onClick={() => accept("packaging")}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => startEdit("packaging")}>עריכת ההמלצה / ההחלטה</button></>}</div>
        </article>

        <article className="bp-week-rec-card">
          <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{brew.length} המלצות</b></header>
          {current.brews.length > 0 && <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.map((b) => <div className="bp-rec-line" key={b.id}><b>{displayStyle(b.style)} · מיכל {sourceNumber(b.tankId)} · {fmt(b.liters)} ל׳</b>{editing === "brew" && <BrewEditRow id={`saved:${b.id}`} value={brewDraft[`saved:${b.id}`] ?? { style: b.style, tankId: b.tankId, liters: b.liters }} sources={sources} onChange={(value) => setBrewDraft((d) => ({ ...d, [`saved:${b.id}`]: value }))}/>}</div>)}</div>}
          <div className="bp-decided-list"><b>המלצות לידיעה</b>{brewingLines.length ? brewingLines.map(({ action }) => <div className="bp-rec-line" key={action.id}><b>{displayStyle(action.style)} · מיכל {sourceNumber(action.tankId)} · {fmt(action.liters)} ל׳</b><span>{action.reason}</span>{editing === "brew" && !current.brews.some((x) => x.id === action.id) && <BrewEditRow id={`rec:${action.id}`} value={brewDraft[`rec:${action.id}`] ?? { style: action.style, tankId: action.tankId, liters: action.liters }} sources={sources} onChange={(value) => setBrewDraft((d) => ({ ...d, [`rec:${action.id}`]: value }))}/>}</div>) : <p className="bp-muted">אין כרגע המלצת בישול נוספת.</p>}</div>
          <div className="bp-actions">{editing === "brew" ? <><button disabled={busy} onClick={() => saveEdited("brew")}>שמירת החלטת הבישול</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !brew.length} onClick={() => accept("brew")}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => startEdit("brew")}>עריכת ההמלצה / ההחלטה</button></>}</div>
        </article>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function BrewEditRow({ id, value, sources, onChange }: { id: string; value: BrewDraft; sources: Fermentor[]; onChange: (value: BrewDraft) => void }) {
  return <div className="bp-brew-edit-row" data-id={id}>
    <label>סגנון<select value={CORE_STYLES.some((s) => sameStyle(s, value.style)) ? displayStyle(value.style) : value.style} onChange={(e) => onChange({ ...value, style: e.target.value })}>{CORE_STYLES.map((s) => <option key={s} value={s}>{displayStyle(s)}</option>)}</select></label>
    <label>מיכל<select value={value.tankId} onChange={(e) => { const source = sources.find((s) => s.id === e.target.value); const liters = source ? Number(source.beerVolume) || estimatedBrewVolume(source.tankNumber, value.style) : value.liters; onChange({ ...value, tankId: e.target.value, liters: liters || value.liters }); }}><option value="">בחירת מיכל</option>{sources.filter((s) => Number(s.tankNumber) !== 1).map((s) => <option key={s.id} value={s.id}>{s.tankNumber} · {Number(s.action) === 0 ? "מחכה לבישול" : "מיכל"}</option>)}</select></label>
    <label>ליטרים<input type="number" min="1" value={value.liters || ""} onChange={(e) => onChange({ ...value, liters: Number(e.target.value) })}/></label>
  </div>;
}
