import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import {
  addDays, emptyWeek, litersPerUnit, sameStyle, weekNumber, weekStart,
  type Actual, type DeliveryPlan, type Holiday, type Plan, type Product, type Settings, type Tank, type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { CORE_STYLES, displayStyle, isCoreStyle } from "../../SERVICES/planning/planningPresentation";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { weekday } from "../../SERVICES/planning/productionCycle";

type Kind = "delivery" | "packaging" | "brew";
type BrewDraft = { style: string; liters: number };
type ManualPack = { tankId: string; productId: string; quantity: number };
const fmt = (n: number) => Math.round(n).toLocaleString("he-IL");
const palletSize = (p: Product) => p.type === "crates" ? 84 : 20;
const defaultWeek = (today: string) => weekday(today) >= 5 ? addDays(weekStart(today), 7) : weekStart(today);
const cover = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)} שב׳`;

export default function PlanningWeeklyPlanner({ settings, plans, tanks, sources, pallets, actuals, shipments, holidays, today, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; sources: Fermentor[]; pallets: Pallet[]; actuals: Actual[];
  shipments: ShipmentEvent[]; holidays: Holiday[]; today: string; disabled: boolean; saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(() => defaultWeek(today));
  const [editing, setEditing] = useState<Kind | null>(null);
  const [shipDraft, setShipDraft] = useState<Record<string, number>>({});
  const [packDraft, setPackDraft] = useState<Record<string, number>>({});
  const [manualPack, setManualPack] = useState<ManualPack>({ tankId: "", productId: "", quantity: 0 });
  const [brewDraft, setBrewDraft] = useState<BrewDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const model = useMemo(() => buildWeeklyPlanningModel({ settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments }), [settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments]);
  const products = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const byId = (id: string) => settings.products.find((p) => p.id === id);
  const shipRec = new Map(model.shipmentRecommendation.map((r) => [r.productId, r]));
  const packRec = new Map<string, number>();
  model.packagingRecommendation.forEach((r) => packRec.set(r.productId, (packRec.get(r.productId) ?? 0) + r.quantity));

  const decidedShip = (id: string) => (current.deliveries ?? []).filter((d) => d.productId === id).reduce((s, d) => s + d.quantity, 0);
  const decidedPack = (id: string) => current.packaging.filter((r) => r.productId === id).reduce((s, r) => s + r.quantity, 0);
  const draftSlots = (draft: Record<string, number>) => {
    const manifest = products.flatMap((p) => projectedPallets(p, Math.max(0, draft[p.id] ?? 0), `weekly-draft:${week}:${p.id}`).map((x) => x.pallet));
    try { return manifest.length ? calcTruckSlots(manifest) : 0; } catch { return Infinity; }
  };

  function begin(kind: Kind) {
    setEditing(kind); setMessage("");
    if (kind === "delivery") setShipDraft(Object.fromEntries(products.map((p) => [p.id, decidedShip(p.id)])));
    if (kind === "packaging") {
      const values: Record<string, number> = {};
      current.packaging.forEach((r) => { values[r.id ?? `${r.productId}:${r.tankId}`] = r.quantity; });
      model.packagingRecommendation.forEach((r) => { values[`rec:${r.id}`] = 0; });
      setPackDraft(values); setManualPack({ tankId: "", productId: "", quantity: 0 });
    }
    if (kind === "brew") setBrewDraft(current.brews.map((b) => ({ style: b.style, liters: b.liters })));
  }

  function stepShipment(p: Product, delta: number) {
    setShipDraft((prev) => {
      const next = { ...prev, [p.id]: Math.max(0, (prev[p.id] ?? 0) + delta * palletSize(p)) };
      if (delta > 0 && draftSlots(next) > MAX_TRUCK_SLOTS) { setMessage("המשאית מלאה — 12/12 מקומות."); return prev; }
      setMessage(""); return next;
    });
  }

  async function saveShipment(draft = shipDraft, reason = "עדכון החלטת משלוח שבועית") {
    const slots = draftSlots(draft);
    if (slots !== 0 && slots !== MAX_TRUCK_SLOTS) { setMessage(`משלוח רגיל צריך להיות מלא: ${slots}/12 מקומות.`); return; }
    const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
    const deliveries: DeliveryPlan[] = products.flatMap((p) => {
      const quantity = draft[p.id] ?? 0;
      return quantity > 0 ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
    });
    setBusy(true); setMessage("");
    try { await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: reason }); setEditing(null); setMessage("החלטת המשלוח נשמרה."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); } finally { setBusy(false); }
  }

  function setManualTank(tankId: string) {
    const tank = tanks.find((t) => t.id === tankId);
    const p = tank ? products.find((x) => sameStyle(x.style, tank.style)) : undefined;
    setManualPack({ tankId, productId: p?.id ?? "", quantity: tank && p ? Math.floor(tank.liters / litersPerUnit(p)) : 0 });
  }
  function setManualProduct(productId: string) {
    const tank = tanks.find((t) => t.id === manualPack.tankId); const p = byId(productId);
    setManualPack((m) => ({ ...m, productId, quantity: tank && p ? Math.floor(tank.liters / litersPerUnit(p)) : 0 }));
  }

  async function savePackaging(replaceWithRecommendation = false) {
    let packaging: Plan[] = replaceWithRecommendation ? [] : current.packaging.map((r) => ({ ...r, quantity: Math.max(0, packDraft[r.id ?? `${r.productId}:${r.tankId}`] ?? r.quantity) })).filter((r) => r.quantity > 0);
    for (const rec of model.packagingRecommendation) {
      const quantity = replaceWithRecommendation ? rec.quantity : Math.max(0, packDraft[`rec:${rec.id}`] ?? 0);
      if (!quantity) continue;
      const p = byId(rec.productId)!;
      packaging.push({ id: rec.id, productId: rec.productId, quantity, tankId: rec.tankId, tankNumber: rec.tankNumber, source: "recommendation", emptyTank: rec.liters - quantity * litersPerUnit(p) < 20 });
    }
    if (!replaceWithRecommendation && manualPack.tankId && manualPack.productId && manualPack.quantity > 0) {
      const tank = tanks.find((t) => t.id === manualPack.tankId)!; const p = byId(manualPack.productId)!;
      packaging.push({ id: crypto.randomUUID(), productId: p.id, quantity: manualPack.quantity, tankId: tank.id, tankNumber: String(tank.number), source: "manual", emptyTank: tank.liters - manualPack.quantity * litersPerUnit(p) < 20 });
    }
    setBusy(true); setMessage("");
    try { await saveWeek({ ...current, packaging, changeReason: replaceWithRecommendation ? "אישור המלצת אריזה שבועית" : "עדכון החלטת אריזה שבועית" }); setEditing(null); setMessage("החלטת האריזה נשמרה."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה"); } finally { setBusy(false); }
  }

  async function saveBrews() {
    const brews = brewDraft.filter((b) => b.style && b.liters > 0).map((b) => ({ id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1) }));
    setBusy(true); setMessage("");
    try { await saveWeek({ ...current, brews, changeReason: "עדכון החלטת בישול שבועית" }); setEditing(null); setMessage("החלטת הבישול נשמרה."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "שמירת הבישול נכשלה"); } finally { setBusy(false); }
  }

  return <section className="bp-weekly-planner">
    <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">אותו סדר חשיבה כמו בגליון: מלאי וכיסוי → משלוח → אריזה → בישול. המערכת ממליצה; המתכנן מחליט.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={w === week} onClick={() => { setWeek(w); setEditing(null); setMessage(""); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    {holidays.filter((h) => h.date >= week && h.date <= model.weekEnd).length > 0 && <div className="bp-week-events"><b>חגים / מגבלות השבוע</b>{holidays.filter((h) => h.date >= week && h.date <= model.weekEnd).map((h) => <span key={`${h.date}:${h.title}`}>{shortDate(h.date)} · {h.title}{h.closed ? " · סגור" : ""}</span>)}</div>}
    {message && <p role="status" className="bp-week-message">{message}</p>}

    <div className="bp-week-recommendations">
      <article className="bp-week-rec-card bp-week-shipment-card">
        <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{model.shipmentSlots}/12 מקומות בהמלצה</b></header>
        <p className="bp-rec-principle">כיסוי טמפו צפוי לסוף השבוע. המדידה האחרונה היא נקודת הפתיחה; מכירות נגרעות רק מהיום קדימה. ההמלצה לא נשענת על החלטת המשלוח של אותו שבוע.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי</span><span>מומלץ</span><span>נקבע</span></div>{products.map((p) => {
          const base = model.rows.base.get(p.id); const after = model.rows.afterShipment.get(p.id); const rec = shipRec.get(p.id); const decided = decidedShip(p.id); const decidedPallets = Math.ceil(decided / palletSize(p));
          const risk = (after?.tempoCover ?? Infinity) < settings.targetWeeks; const mismatch = risk && decidedPallets < (rec?.pallets ?? 0);
          return <div className={`bp-shipment-plan-row ${risk ? "is-warning" : "is-ok"} ${mismatch ? "gap-warning" : ""}`} key={p.id}><span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span><span>{cover(base?.tempoCover)}<small>מבשלה צפויה: {fmt(base?.breweryUnits ?? 0)}</small></span><span>{rec?.pallets ?? 0} מש׳<small>{rec?.slots ?? 0} מק׳</small></span><span>{editing === "delivery" ? <div className="bp-stepper"><button onClick={() => stepShipment(p,-1)}>−</button><b>{Math.round((shipDraft[p.id] ?? 0)/palletSize(p))}</b><button onClick={() => stepShipment(p,1)}>+</button><small>משטחים</small></div> : <>{decidedPallets} מש׳<small>אחרי החלטה: {cover(after?.tempoCover)}</small></>}</span></div>;
        })}</div>
        {!model.shipmentCanFillTruck && <p className="bp-muted">אין כרגע מספיק מלאי צפוי להרכבת 12/12 מקומות; זו אינה המלצת יציאה.</p>}
        <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={() => saveShipment()}>שמירה</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !model.shipmentCanFillTruck} onClick={() => saveShipment(Object.fromEntries(products.map((p) => [p.id, shipRec.get(p.id)?.quantity ?? 0])), "אישור המלצת משלוח שבועית")}>קבל המלצת 12/12</button><button disabled={disabled || busy} onClick={() => begin("delivery")}>עריכת המשלוח</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{model.packagingDays}/{model.packagingCapacity} ימי אריזה</b></header>
        <p className="bp-rec-principle">האריזה מחושבת אחרי החלטת המשלוח ששמרת. ההמלצה מוגבלת לימי האריזה ומנסה לשחרר מיכלים, אבל אפשר להוסיף החלטה עצמאית בכל עת.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי כולל</span><span>מומלץ</span><span>נקבע</span></div>{products.map((p) => {
          const before = model.rows.afterShipment.get(p.id); const after = model.rows.afterPackaging.get(p.id); const rec = packRec.get(p.id) ?? 0; const decided = decidedPack(p.id); const target = settings.totalTargetWeeks ?? settings.targetWeeks; const risk = (after?.totalCover ?? Infinity) < target; const mismatch = risk && decided < rec;
          return <div className={`bp-shipment-plan-row ${risk ? "is-warning" : "is-ok"} ${mismatch ? "gap-warning" : ""}`} key={p.id}><span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span><span>{cover(before?.totalCover)}</span><span>{fmt(rec)}</span><span>{fmt(decided)}<small>אחרי החלטה: {cover(after?.totalCover)}</small></span></div>;
        })}</div>
        {editing === "packaging" && <div className="bp-decided-list"><b>החלטות קיימות</b>{current.packaging.length ? current.packaging.map((r) => { const p=byId(r.productId); const key=r.id ?? `${r.productId}:${r.tankId}`; const value=packDraft[key] ?? r.quantity; return <div className="bp-rec-line" key={key}><span><b>{p?displayStyle(p.style):r.productId}</b> · מיכל {r.tankNumber ?? tanks.find((t)=>t.id===r.tankId)?.number ?? "—"}</span><input type="number" min="0" value={value} onChange={(e)=>setPackDraft((d)=>({...d,[key]:Math.max(0,Number(e.target.value))}))}/><button onClick={()=>setPackDraft((d)=>({...d,[key]:0}))}>הסר</button></div>; }) : <small>אין החלטות אריזה.</small>}
          <b>המלצות</b>{model.packagingRecommendation.map((r)=>{ const p=byId(r.productId)!; const key=`rec:${r.id}`; const value=packDraft[key] ?? 0; return <div className="bp-rec-line" key={r.id}><span><b>{displayStyle(p.style)} · {p.type==="crates"?"ארגזים":"חביות"}</b> · מיכל {r.tankNumber}</span><input type="number" min="0" max={r.quantity} value={value} onChange={(e)=>setPackDraft((d)=>({...d,[key]:Math.min(r.quantity,Math.max(0,Number(e.target.value)))}))}/><button onClick={()=>setPackDraft((d)=>({...d,[key]:value?0:r.quantity}))}>{value?"בטל":`הוסף ${fmt(r.quantity)}`}</button></div>; })}
          <div className="bp-manual-pack"><b>+ אריזה עצמאית</b><label>מיכל<select value={manualPack.tankId} onChange={(e)=>setManualTank(e.target.value)}><option value="">בחר</option>{tanks.filter((t)=>t.ready<=model.weekEnd && t.liters>=20).map((t)=><option key={t.id} value={t.id}>מיכל {t.number} · {displayStyle(t.style)} · {fmt(t.liters)} ל׳</option>)}</select></label><label>פורמט<select value={manualPack.productId} disabled={!manualPack.tankId} onChange={(e)=>setManualProduct(e.target.value)}><option value="">בחר</option>{products.filter((p)=>{const t=tanks.find((x)=>x.id===manualPack.tankId);return !!t&&sameStyle(p.style,t.style);}).map((p)=><option key={p.id} value={p.id}>{p.type==="crates"?"ארגזים":"חביות"}</option>)}</select></label><label>כמות<input type="number" min="0" value={manualPack.quantity||""} onChange={(e)=>setManualPack((m)=>({...m,quantity:Math.max(0,Number(e.target.value))}))}/></label></div>
        </div>}
        <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={()=>savePackaging(false)}>שמירה</button><button onClick={()=>setEditing(null)}>ביטול</button></> : <><button disabled={disabled||busy||!model.packagingRecommendation.length} onClick={()=>savePackaging(true)}>קבל את ההמלצה</button><button disabled={disabled||busy} onClick={()=>begin("packaging")}>עריכת האריזות</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{model.availableBrewTanks} מיכלים זמינים לפי ההחלטות</b></header>
        <p className="bp-rec-principle">הבישול מחושב אחרי משלוח ואריזה. המתכנן בוחר מה לבשל; מנהל העבודה ישבץ יום ומיכל.</p>
        <div className="bp-decided-list"><b>המלצת המערכת</b>{model.brewRecommendations.length?model.brewRecommendations.map((r,i)=><div className="bp-rec-line" key={`${r.style}:${i}`}><b>{displayStyle(r.style)}</b><span>{fmt(r.liters)} ל׳</span></div>):<small>אין המלצה כרגע.</small>}</div>
        <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.length?current.brews.map((b)=><div className="bp-rec-line" key={b.id}><b>{displayStyle(b.style)}</b><span>{fmt(b.liters)} ל׳</span></div>):<small>טרם נקבעו בישולים.</small>}</div>
        {editing==="brew"&&<div className="bp-decided-list"><b>עריכת החלטה</b>{brewDraft.map((b,i)=><div className="bp-brew-edit-row" key={i}><select value={b.style} onChange={(e)=>setBrewDraft((d)=>d.map((x,j)=>j===i?{...x,style:e.target.value}:x))}>{CORE_STYLES.map((s)=><option key={s} value={s}>{displayStyle(s)}</option>)}</select><input type="number" min="1" value={b.liters} onChange={(e)=>setBrewDraft((d)=>d.map((x,j)=>j===i?{...x,liters:Number(e.target.value)}:x))}/><button onClick={()=>setBrewDraft((d)=>d.filter((_,j)=>j!==i))}>הסר</button></div>)}<button onClick={()=>setBrewDraft((d)=>[...d,{style:model.brewRecommendations[d.length]?.style??CORE_STYLES[0],liters:model.brewRecommendations[d.length]?.liters??2500}])}>+ הוסף בישול</button></div>}
        <div className="bp-actions">{editing==="brew"?<><button disabled={busy} onClick={saveBrews}>שמירה</button><button onClick={()=>setEditing(null)}>ביטול</button></>:<button disabled={disabled||busy} onClick={()=>begin("brew")}>עריכת הבישולים</button>}</div>
      </article>
    </div>
  </section>;
}
