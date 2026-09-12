import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import { addDays, emptyWeek, sameStyle, weeklyDemand, weekNumber, weekStart, type DeliveryPlan, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { estimatedBrewVolume } from "../../SERVICES/planning/productionCycle";
import { CORE_STYLES, displayStyle, isCoreStyle } from "../../SERVICES/planning/planningPresentation";
import { adoptAction, type PlanningAction, type planningWorkspace } from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
type DeliveryAction = PlanningAction & { kind: "delivery"; productId: string; quantity: number; pallets?: Pallet[]; slots?: number; truckId?: string };
type PackagingAction = PlanningAction & { kind: "packaging"; productId: string; quantity: number; allocations: { tankId: string; number: string; liters: number; ready: string; cold: boolean }[]; reason?: string };
type BrewAction = PlanningAction & { kind: "brew"; style: string; tankId: string; liters: number; reason: string };
type Kind = PlanningAction["kind"];
type BrewDraft = { style: string; tankId: string; liters: number };
const fmt = (n: number) => Math.round(n).toLocaleString("he-IL", { maximumFractionDigits: 0 });

export default function PlanningWeeklyRecommendations({ settings, plans, tanks, sources, pallets, today, workspace, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; sources: Fermentor[]; pallets: Pallet[]; today: string;
  workspace: Workspace; disabled: boolean; saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [editing, setEditing] = useState<Kind | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});
  const [brewDraft, setBrewDraft] = useState<Record<string, BrewDraft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const actions = useMemo(() => workspace.actions.filter((a) => weekStart(a.date) === week), [workspace.actions, week]);
  const ship = actions.filter((a) => a.kind === "delivery") as DeliveryAction[];
  const pack = actions.filter((a) => a.kind === "packaging") as PackagingAction[];
  const brew = actions.filter((a) => a.kind === "brew") as BrewAction[];
  const product = (id: string) => settings.products.find((p) => p.id === id);
  const coreProducts = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const sourceNumber = (id: string) => sources.find((s) => s.id === id)?.tankNumber ?? tanks.find((t) => t.id === id)?.number ?? id;

  const warnings = useMemo(() => workspace.needs.filter((n) => weekStart(n.date) === week).map((n) => {
    const scheduled = n.kind === "packaging"
      ? current.packaging.filter((p) => p.productId === n.productId).reduce((sum, p) => sum + p.quantity, 0)
      : current.brews.filter((b) => sameStyle(b.style, n.style)).reduce((sum, b) => sum + b.liters, 0);
    const explanation = n.problem.includes("כבר מוקצה") ? "הכמות שכבר שובצה ממיכל זה אינה מספיקה לצורך המחושב." : n.problem;
    return `${displayStyle(n.style)}: נקבע ${fmt(scheduled)} ${n.kind === "brew" ? "ל׳" : n.unit}; עדיין חסרים כ־${fmt(n.quantity)} ${n.unit}. ${explanation}`;
  }).slice(0, 6), [workspace.needs, week, current.packaging, current.brews]);

  const availableFor = (id: string) => {
    const p = product(id);
    if (!p) return { physicalPallets: 0, physicalQty: 0, plannedPallets: 0, plannedQty: 0 };
    const physical = pallets.filter((x) => x.zone !== "shipped" && x.itemType === p.type && sameStyle(x.beerStyle, p.style));
    const plannedQty = current.packaging.filter((x) => x.productId === p.id).reduce((sum, x) => sum + x.quantity, 0);
    return { physicalPallets: physical.length, physicalQty: physical.reduce((sum, x) => sum + x.quantity, 0), plannedPallets: plannedQty ? projectedPallets(p, plannedQty, `week:${week}`).length : 0, plannedQty };
  };

  const shipmentRows = coreProducts.map((p) => {
    const recommendedQty = ship.filter((a) => a.productId === p.id).reduce((s, a) => s + a.quantity, 0);
    const decidedQty = (current.deliveries ?? []).filter((d) => d.productId === p.id).reduce((s, d) => s + d.quantity, 0);
    const cover = p.tempo === null || weeklyDemand(p) <= 0 ? null : p.tempo / weeklyDemand(p);
    return {
      p, recommendedQty, decidedQty,
      recPallets: recommendedQty ? projectedPallets(p, recommendedQty, `rec:${week}:${p.id}`).length : 0,
      decidedPallets: decidedQty ? projectedPallets(p, decidedQty, `dec:${week}:${p.id}`).length : 0,
      availability: availableFor(p.id), cover,
      severity: cover === null ? "neutral" : cover < 1 ? "critical" : cover < settings.targetWeeks ? "warning" : "ok",
    };
  });

  const recommendedTruckSlots = useMemo(() => {
    const manifest = ship.flatMap((a) => a.pallets ?? []);
    if (!manifest.length) return 0;
    try { return calcTruckSlots(manifest); } catch { return 0; }
  }, [ship]);

  const decidedTruckSlots = () => {
    try {
      const manifest = (current.deliveries ?? []).flatMap((d) => {
        const p = product(d.productId);
        return p ? projectedPallets(p, d.quantity, d.id).map((x) => x.pallet) : [];
      });
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch { return 0; }
  };

  function startEdit(kind: Kind) {
    setEditing(kind); setMessage("");
    const qty: Record<string, number> = {};
    if (kind === "delivery") shipmentRows.forEach((r) => { qty[`ship:${r.p.id}`] = r.decidedQty || r.recommendedQty; });
    if (kind === "packaging") {
      current.packaging.forEach((r) => { qty[`saved:${r.id}`] = r.quantity; });
      pack.forEach((a) => { qty[`rec:${a.id}`] = a.quantity; });
    }
    if (kind === "brew") {
      const drafts: Record<string, BrewDraft> = {};
      current.brews.forEach((b) => { drafts[`saved:${b.id}`] = { style: b.style, tankId: b.tankId, liters: b.liters }; });
      brew.forEach((a) => { drafts[`rec:${a.id}`] = { style: a.style, tankId: a.tankId, liters: a.liters }; });
      setBrewDraft(drafts);
    }
    setDraftQty(qty);
  }

  async function saveEdited(kind: Kind) {
    setBusy(true); setMessage("");
    try {
      let next = structuredClone(current);
      if (kind === "delivery") {
        const date = current.deliveries?.[0]?.dispatchDate ?? ship[0]?.date ?? addDays(week, 1);
        const deliveries: DeliveryPlan[] = [];
        for (const p of coreProducts) {
          const quantity = Math.max(0, Number(draftQty[`ship:${p.id}`] ?? 0));
          if (quantity) deliveries.push({ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${date}`, pallets: [] });
        }
        next.deliveries = deliveries;
        next.deliveryDates = deliveries.length ? [date] : [];
      } else if (kind === "packaging") {
        next.packaging = next.packaging.map((r) => ({ ...r, quantity: Math.max(0, Number(draftQty[`saved:${r.id}`] ?? r.quantity)) })).filter((r) => r.quantity > 0);
        for (const a of pack) if (!next.packaging.some((x) => x.id === a.id)) {
          const quantity = Math.max(0, Number(draftQty[`rec:${a.id}`] ?? 0));
          if (quantity) next = adoptAction(next, { ...a, quantity } as PlanningAction);
        }
      } else {
        next.brews = next.brews.map((b) => ({ ...b, ...(brewDraft[`saved:${b.id}`] ?? {}) }));
        for (const a of brew) if (!next.brews.some((x) => x.id === a.id)) {
          const d = brewDraft[`rec:${a.id}`];
          if (d?.tankId && d.style && d.liters > 0) next = adoptAction(next, { ...a, ...d } as PlanningAction);
        }
      }
      next.changeReason = `עריכת החלטת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next); setEditing(null); setMessage("ההחלטה השבועית נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); }
    finally { setBusy(false); }
  }

  async function accept(kind: Kind) {
    const selected = actions.filter((a) => a.kind === kind);
    if (!selected.length) return;
    setBusy(true); setMessage("");
    try {
      let next = structuredClone(current);
      for (const a of selected) {
        const exists = a.kind === "brew" ? next.brews.some((x) => x.id === a.id) : a.kind === "packaging" ? next.packaging.some((x) => x.id === a.id) : (next.deliveries ?? []).some((x) => x.id === a.id);
        if (!exists) next = adoptAction(next, a);
      }
      next.changeReason = `אישור המלצת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next); setMessage("ההמלצה נשמרה כהחלטה שבועית.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); }
    finally { setBusy(false); }
  }

  return <section className="bp-weekly-planner">
    <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">המתכנן מחליט כאן מה יקרה בשבוע. השיבוץ לימים נשאר באחריות מנהל העבודה.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={week === w} onClick={() => { setWeek(w); setEditing(null); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    {warnings.length > 0 && <div className="bp-week-alerts"><b>אזהרות לתוכנית</b>{warnings.map((w) => <span key={w}>⚠ {w}</span>)}</div>}

    <div className="bp-week-recommendations">
      <article className="bp-week-rec-card bp-week-shipment-card">
        <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{recommendedTruckSlots}/{MAX_TRUCK_SLOTS} מקומות</b></header>
        <p className="bp-rec-principle">משלוח רגיל מומלץ רק ב־12/12 מקומות. המשטחים הספציפיים ייבחרו אחר כך לפי FIFO.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>מומלץ</span><span>נקבע</span><span>זמין / תכנון</span></div>{shipmentRows.map((r) => <div className={`bp-shipment-plan-row is-${r.severity}`} key={r.p.id}>
          <span><b>{displayStyle(r.p.style)}</b><small>{r.p.type === "crates" ? "ארגזים" : "חביות"}{r.cover === null ? "" : ` · ${r.cover.toFixed(1)} שב׳`}</small></span>
          <span>{r.recPallets} מש׳<small>{fmt(r.recommendedQty)}</small></span>
          <span>{editing === "delivery" ? <input type="number" min="0" value={draftQty[`ship:${r.p.id}`] ?? 0} onChange={(e) => setDraftQty((q) => ({ ...q, [`ship:${r.p.id}`]: Number(e.target.value) }))}/> : <>{r.decidedPallets} מש׳<small>{fmt(r.decidedQty)}</small></>}</span>
          <span>{r.availability.physicalPallets} מש׳<small>פיזי {fmt(r.availability.physicalQty)} · תכנון {r.availability.plannedPallets} / {fmt(r.availability.plannedQty)}</small></span>
        </div>)}</div>
        <div className="bp-saved-summary">החלטה נוכחית: {decidedTruckSlots()}/{MAX_TRUCK_SLOTS} מקומות.</div>
        <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={() => saveEdited("delivery")}>שמירת החלטת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || recommendedTruckSlots < MAX_TRUCK_SLOTS} onClick={() => accept("delivery")}>קבל המלצת 12/12</button><button disabled={disabled || busy} onClick={() => startEdit("delivery")}>עריכת ההמלצה / ההחלטה</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{pack.length} המלצות</b></header>
        <DecisionPackaging title="החלטות שנקבעו" rows={current.packaging.map((r) => ({ id: `saved:${r.id}`, text: `${displayStyle(product(r.productId)?.style ?? r.productId)} · ${fmt(r.quantity)} ${product(r.productId)?.type === "crates" ? "ארגזים" : "חביות"}`, sub: `מיכל ${tanks.find((t) => t.id === r.tankId)?.number ?? r.tankNumber ?? "?"}`, value: r.quantity }))} editing={editing === "packaging"} draftQty={draftQty} setDraftQty={setDraftQty}/>
        <DecisionPackaging title="המלצות לידיעה" rows={pack.map((a) => ({ id: `rec:${a.id}`, text: `${displayStyle(product(a.productId)?.style ?? a.productId)} · ${fmt(a.quantity)} ${product(a.productId)?.type === "crates" ? "ארגזים" : "חביות"}`, sub: `מיכל ${a.allocations[0]?.number ?? "ללא מיכל ישים"} · ${a.reason ?? ""}`, value: a.quantity }))} editing={editing === "packaging"} draftQty={draftQty} setDraftQty={setDraftQty}/>
        <p className="bp-rec-principle">ברירת המחדל היא לרוקן מיכל באותו שבוע; פיצול חייב להיות מוצג במפורש.</p>
        <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={() => saveEdited("packaging")}>שמירת החלטת האריזה</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !pack.length} onClick={() => accept("packaging")}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => startEdit("packaging")}>עריכת ההמלצה / ההחלטה</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{brew.length} המלצות</b></header>
        <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.length ? current.brews.map((b) => <div className="bp-rec-line" key={b.id}><b>{displayStyle(b.style)} · מיכל {sourceNumber(b.tankId)} · {fmt(b.liters)} ל׳</b>{editing === "brew" && <BrewEditRow value={brewDraft[`saved:${b.id}`] ?? { style: b.style, tankId: b.tankId, liters: b.liters }} sources={sources} onChange={(v) => setBrewDraft((d) => ({ ...d, [`saved:${b.id}`]: v }))}/>}</div>) : <small>טרם נקבע</small>}</div>
        <div className="bp-decided-list"><b>המלצות לידיעה</b>{brew.length ? brew.map((a) => <div className="bp-rec-line" key={a.id}><b>{displayStyle(a.style)} · מיכל {sourceNumber(a.tankId)} · {fmt(a.liters)} ל׳</b><span>{a.reason}</span>{editing === "brew" && !current.brews.some((x) => x.id === a.id) && <BrewEditRow value={brewDraft[`rec:${a.id}`] ?? { style: a.style, tankId: a.tankId, liters: a.liters }} sources={sources} onChange={(v) => setBrewDraft((d) => ({ ...d, [`rec:${a.id}`]: v }))}/>}</div>) : <small>אין המלצה נוספת</small>}</div>
        <div className="bp-actions">{editing === "brew" ? <><button disabled={busy} onClick={() => saveEdited("brew")}>שמירת החלטת הבישול</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !brew.length} onClick={() => accept("brew")}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => startEdit("brew")}>עריכת ההמלצה / ההחלטה</button></>}</div>
      </article>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}

function DecisionPackaging({ title, rows, editing, draftQty, setDraftQty }: { title: string; rows: { id: string; text: string; sub: string; value: number }[]; editing: boolean; draftQty: Record<string, number>; setDraftQty: React.Dispatch<React.SetStateAction<Record<string, number>>> }) {
  return <div className="bp-decided-list"><b>{title}</b>{rows.length ? rows.map((r) => <div className="bp-rec-line" key={r.id}><b>{r.text}</b><span>{r.sub}</span>{editing && <input type="number" min="0" value={draftQty[r.id] ?? r.value} onChange={(e) => setDraftQty((q) => ({ ...q, [r.id]: Number(e.target.value) }))}/>}</div>) : <small>אין</small>}</div>;
}

function BrewEditRow({ value, sources, onChange }: { value: BrewDraft; sources: Fermentor[]; onChange: (value: BrewDraft) => void }) {
  return <div className="bp-brew-edit-row">
    <label>סגנון<select value={CORE_STYLES.some((s) => sameStyle(s, value.style)) ? displayStyle(value.style) : value.style} onChange={(e) => onChange({ ...value, style: e.target.value })}>{CORE_STYLES.map((s) => <option key={s} value={s}>{displayStyle(s)}</option>)}</select></label>
    <label>מיכל<select value={value.tankId} onChange={(e) => { const source = sources.find((s) => s.id === e.target.value); const liters = source ? Number(source.beerVolume) || estimatedBrewVolume(source.tankNumber, value.style) : value.liters; onChange({ ...value, tankId: e.target.value, liters: liters || value.liters }); }}><option value="">בחירת מיכל</option>{sources.filter((s) => Number(s.tankNumber) !== 1).map((s) => <option key={s.id} value={s.id}>{s.tankNumber} · {Number(s.action) === 0 ? "מחכה לבישול" : "מיכל"}</option>)}</select></label>
    <label>ליטרים<input type="number" min="1" value={value.liters || ""} onChange={(e) => onChange({ ...value, liters: Number(e.target.value) })}/></label>
  </div>;
}
