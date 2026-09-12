import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  sameStyle,
  weekNumber,
  weekStart,
  type Actual,
  type DeliveryPlan,
  type Holiday,
  type Plan,
  type Product,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle, isCoreStyle, CORE_STYLES } from "../../SERVICES/planning/planningPresentation";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { weekday } from "../../SERVICES/planning/productionCycle";

type Kind = "delivery" | "packaging" | "brew";
type BrewDraft = { style: string; liters: number };
type ManualPackDraft = { tankId: string; productId: string; quantity: number };

const fmt = (n: number) => Math.round(n).toLocaleString("he-IL");
const palletSize = (p: Product) => (p.type === "crates" ? 84 : 20);
const defaultWeek = (today: string) => weekday(today) >= 5 ? addDays(weekStart(today), 7) : weekStart(today);

function coverLabel(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} שב׳`;
}

export default function PlanningWeeklyRecommendationsV2({ settings, plans, tanks, sources, pallets, actuals, shipments, holidays, today, disabled, saveWeek }: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  actuals: Actual[];
  shipments: ShipmentEvent[];
  holidays: Holiday[];
  today: string;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(() => defaultWeek(today));
  const [editing, setEditing] = useState<Kind | null>(null);
  const [shipDraft, setShipDraft] = useState<Record<string, number>>({});
  const [packDraft, setPackDraft] = useState<Record<string, number>>({});
  const [manualPack, setManualPack] = useState<ManualPackDraft>({ tankId: "", productId: "", quantity: 0 });
  const [brewDraft, setBrewDraft] = useState<BrewDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const model = useMemo(() => buildWeeklyPlanningModel({ settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments }), [settings, pallets, tanks, plans, actuals, sources, today, week, holidays, shipments]);
  const products = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const product = (id: string) => settings.products.find((p) => p.id === id);
  const holidaysThisWeek = holidays.filter((h) => h.date >= week && h.date <= model.weekEnd);

  const shipmentRec = new Map(model.shipmentRecommendation.map((r) => [r.productId, r]));
  const packagingRecByProduct = new Map<string, number>();
  for (const r of model.packagingRecommendation) packagingRecByProduct.set(r.productId, (packagingRecByProduct.get(r.productId) ?? 0) + r.quantity);

  function currentShipmentQty(productId: string) {
    return (current.deliveries ?? []).filter((d) => d.productId === productId).reduce((s, d) => s + d.quantity, 0);
  }
  function currentPackagingQty(productId: string) {
    return current.packaging.filter((r) => r.productId === productId).reduce((s, r) => s + r.quantity, 0);
  }
  function shipmentSlots(draft: Record<string, number>) {
    const manifest = products.flatMap((p) => projectedPallets(p, Math.max(0, draft[p.id] ?? 0), `weekly-edit:${week}:${p.id}`).map((x) => x.pallet));
    if (!manifest.length) return 0;
    try {
      const { calcTruckSlots } = requireTruckCapacity();
      return calcTruckSlots(manifest);
    } catch {
      return Infinity;
    }
  }

  function beginEdit(kind: Kind) {
    setEditing(kind); setMessage("");
    if (kind === "delivery") {
      const next: Record<string, number> = {};
      for (const p of products) next[p.id] = currentShipmentQty(p.id);
      setShipDraft(next);
    } else if (kind === "packaging") {
      const next: Record<string, number> = {};
      for (const r of current.packaging) next[r.id ?? `${r.productId}:${r.tankId}`] = r.quantity;
      setPackDraft(next); setManualPack({ tankId: "", productId: "", quantity: 0 });
    } else {
      setBrewDraft(current.brews.map((b) => ({ style: b.style, liters: b.liters })));
    }
  }

  function stepShipment(p: Product, delta: number) {
    const step = palletSize(p);
    setShipDraft((prev) => {
      const next = { ...prev, [p.id]: Math.max(0, (prev[p.id] ?? 0) + delta * step) };
      const slots = shipmentSlots(next);
      if (delta > 0 && slots > MAX_TRUCK_SLOTS) {
        setMessage(`המשאית מלאה — מקסימום ${MAX_TRUCK_SLOTS} מקומות.`);
        return prev;
      }
      setMessage("");
      return next;
    });
  }

  async function saveShipment() {
    const slots = shipmentSlots(shipDraft);
    if (slots !== 0 && slots !== MAX_TRUCK_SLOTS) {
      setMessage(`משלוח רגיל צריך לצאת מלא: כרגע ${slots}/${MAX_TRUCK_SLOTS} מקומות.`);
      return;
    }
    setBusy(true); setMessage("");
    try {
      const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
      const deliveries: DeliveryPlan[] = products.flatMap((p) => {
        const quantity = Math.max(0, shipDraft[p.id] ?? 0);
        return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
      });
      await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "עדכון החלטת משלוח שבועית" });
      setEditing(null); setMessage("החלטת המשלוח נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  async function acceptShipmentRecommendation() {
    const draft: Record<string, number> = {};
    for (const p of products) draft[p.id] = shipmentRec.get(p.id)?.quantity ?? 0;
    setShipDraft(draft);
    const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
    const deliveries: DeliveryPlan[] = products.flatMap((p) => {
      const quantity = draft[p.id] ?? 0;
      return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
    });
    setBusy(true); setMessage("");
    try {
      await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "אישור המלצת משלוח שבועית" });
      setMessage("המלצת המשלוח נשמרה כהחלטה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  function addRecommendedPackaging() {
    const next = { ...packDraft };
    for (const r of model.packagingRecommendation) next[`rec:${r.id}`] = r.quantity;
    setPackDraft(next);
  }

  function manualProductsForTank(tankId: string) {
    const t = tanks.find((t) => t.id === tankId);
    return t ? products.filter((p) => sameStyle(p.style, t.style)) : [];
  }

  function updateManualTank(tankId: string) {
    const t = tanks.find((t) => t.id === tankId);
    const p = t ? products.find((p) => sameStyle(p.style, t.style)) : undefined;
    const quantity = t && p ? Math.floor(t.liters / litersPerUnit(p)) : 0;
    setManualPack({ tankId, productId: p?.id ?? "", quantity });
  }

  function updateManualProduct(productId: string) {
    const t = tanks.find((t) => t.id === manualPack.tankId);
    const p = product(productId);
    setManualPack((d) => ({ ...d, productId, quantity: t && p ? Math.floor(t.liters / litersPerUnit(p)) : 0 }));
  }

  async function savePackaging() {
    setBusy(true); setMessage("");
    try {
      const packaging: Plan[] = current.packaging
        .map((r) => ({ ...r, quantity: Math.max(0, packDraft[r.id ?? `${r.productId}:${r.tankId}`] ?? r.quantity) }))
        .filter((r) => r.quantity > 0);
      for (const rec of model.packagingRecommendation) {
        const quantity = Math.max(0, packDraft[`rec:${rec.id}`] ?? 0);
        if (!quantity) continue;
        packaging.push({ id: rec.id, productId: rec.productId, quantity, tankId: rec.tankId, tankNumber: rec.tankNumber, source: "recommendation", emptyTank: rec.liters - quantity * litersPerUnit(product(rec.productId)!) < 20 });
      }
      if (manualPack.tankId && manualPack.productId && manualPack.quantity > 0) {
        const t = tanks.find((x) => x.id === manualPack.tankId)!;
        const p = product(manualPack.productId)!;
        packaging.push({ id: crypto.randomUUID(), productId: p.id, quantity: manualPack.quantity, tankId: t.id, tankNumber: String(t.number), source: "manual", emptyTank: t.liters - manualPack.quantity * litersPerUnit(p) < 20 });
      }
      await saveWeek({ ...current, packaging, changeReason: "עדכון החלטת אריזה שבועית" });
      setEditing(null); setMessage("החלטת האריזה נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה"); }
    finally { setBusy(false); }
  }

  async function acceptPackagingRecommendation() {
    const packaging: Plan[] = model.packagingRecommendation.map((r) => ({
      id: r.id, productId: r.productId, quantity: r.quantity, tankId: r.tankId, tankNumber: r.tankNumber, source: "recommendation", emptyTank: r.liters - r.quantity * litersPerUnit(product(r.productId)!) < 20,
    }));
    setBusy(true); setMessage("");
    try {
      await saveWeek({ ...current, packaging, changeReason: "אישור המלצת אריזה שבועית" });
      setMessage("המלצת האריזה נשמרה כהחלטה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה"); }
    finally { setBusy(false); }
  }

  async function saveBrews() {
    setBusy(true); setMessage("");
    try {
      const brews = brewDraft.filter((b) => b.style && b.liters > 0).map((b) => ({ id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1) }));
      await saveWeek({ ...current, brews, changeReason: "עדכון החלטת בישול שבועית" });
      setEditing(null); setMessage("החלטת הבישול נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת הבישול נכשלה"); }
    finally { setBusy(false); }
  }

  return <section className="bp-weekly-planner">
    <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">המערכת מחשבת ומסבירה; המתכנן מחליט. משלוח → אריזה → בישול.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={w === week} onClick={() => { setWeek(w); setEditing(null); setMessage(""); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    {holidaysThisWeek.length > 0 && <div className="bp-week-events"><b>חגים / מגבלות השבוע</b>{holidaysThisWeek.map((h) => <span key={`${h.date}:${h.title}`}>{shortDate(h.date)} · {h.title}{h.closed ? " · סגור" : ""}</span>)}</div>}
    {message && <p role="status" className="bp-week-message">{message}</p>}

    <div className="bp-week-recommendations">
      <article className="bp-week-rec-card bp-week-shipment-card">
        <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{model.shipmentSlots}/{MAX_TRUCK_SLOTS} מקומות בהמלצה</b></header>
        <p className="bp-rec-principle">הכיסוי כאן הוא כיסוי טמפו צפוי לסוף השבוע. מתחילים מהמדידה האחרונה, מפחיתים מכירות מהיום קדימה, ומוסיפים רק החלטות שכבר נשמרו משבועות קודמים.</p>
        <div className="bp-shipment-plan-table">
          <div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי בלי משלוח</span><span>מומלץ</span><span>החלטה</span></div>
          {products.map((p) => {
            const base = model.rows.base.get(p.id); const after = model.rows.afterShipment.get(p.id); const rec = shipmentRec.get(p.id); const decided = currentShipmentQty(p.id); const decidedPallets = Math.ceil(decided / palletSize(p));
            const underTarget = (after?.tempoCover ?? Infinity) < settings.targetWeeks;
            const mismatch = decidedPallets < (rec?.pallets ?? 0) && underTarget;
            return <div className={`bp-shipment-plan-row ${underTarget ? "is-warning" : "is-ok"} ${mismatch ? "gap-warning" : ""}`} key={p.id}>
              <span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span>
              <span>{coverLabel(base?.tempoCover ?? null)}<small>זמין במבשלה: {fmt(base?.breweryUnits ?? 0)}</small></span>
              <span>{rec?.pallets ?? 0} מש׳<small>{rec?.slots ?? 0} מק׳</small></span>
              <span>{editing === "delivery" ? <div className="bp-stepper"><button onClick={() => stepShipment(p, -1)}>−</button><b>{Math.round((shipDraft[p.id] ?? 0) / palletSize(p))}</b><button onClick={() => stepShipment(p, 1)}>+</button><small>משטחים</small></div> : <>{decidedPallets} מש׳<small>אחרי החלטה: {coverLabel(after?.tempoCover ?? null)}</small></>}</span>
            </div>;
          })}
        </div>
        {!model.shipmentCanFillTruck && model.shipmentSlots > 0 && <p className="bp-alert">אין כרגע מספיק מלאי צפוי כדי להרכיב משאית מלאה של 12 מקומות.</p>}
        <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={saveShipment}>שמירת החלטת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !model.shipmentCanFillTruck} onClick={acceptShipmentRecommendation}>קבל המלצת 12/12</button><button disabled={disabled || busy} onClick={() => beginEdit("delivery")}>עריכת המשלוח</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{model.packagingDays}/{model.packagingCapacity} ימי אריזה בהמלצה</b></header>
        <p className="bp-rec-principle">המלצת האריזה מחושבת אחרי החלטת המשלוח ששמרת. היא מוגבלת לימי האריזה, ובברירת המחדל מנסה לרוקן מיכל.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי אחרי משלוח</span><span>מומלץ</span><span>החלטה</span></div>
          {products.map((p) => {
            const before = model.rows.afterShipment.get(p.id); const after = model.rows.afterPackaging.get(p.id); const rec = packagingRecByProduct.get(p.id) ?? 0; const decided = currentPackagingQty(p.id); const underTarget = (after?.totalCover ?? Infinity) < (settings.totalTargetWeeks ?? settings.targetWeeks); const mismatch = decided < rec && underTarget;
            return <div className={`bp-shipment-plan-row ${underTarget ? "is-warning" : "is-ok"} ${mismatch ? "gap-warning" : ""}`} key={p.id}><span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span><span>{coverLabel(before?.totalCover ?? null)}</span><span>{fmt(rec)}</span><span>{fmt(decided)}<small>אחרי החלטה: {coverLabel(after?.totalCover ?? null)}</small></span></div>;
          })}
        </div>
        {editing === "packaging" && <div className="bp-decided-list"><b>החלטות קיימות</b>{current.packaging.length ? current.packaging.map((r) => { const p = product(r.productId); const key = r.id ?? `${r.productId}:${r.tankId}`; const value = packDraft[key] ?? r.quantity; return <div className="bp-rec-line" key={key}><span><b>{p ? displayStyle(p.style) : r.productId}</b> · מיכל {r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number ?? "—"}</span><input type="number" min="0" value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(0, Number(e.target.value)) }))}/><button onClick={() => setPackDraft((d) => ({ ...d, [key]: 0 }))}>הסר</button></div>; }) : <small>אין החלטות אריזה שמורות.</small>}
          <b>המלצות זמינות</b>{model.packagingRecommendation.map((r) => { const p = product(r.productId)!; const key = `rec:${r.id}`; const value = packDraft[key] ?? 0; return <div className="bp-rec-line" key={r.id}><span><b>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}</b> · מיכל {r.tankNumber}</span><input type="number" min="0" max={r.quantity} value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.min(r.quantity, Math.max(0, Number(e.target.value))) }))}/><button onClick={() => setPackDraft((d) => ({ ...d, [key]: value ? 0 : r.quantity }))}>{value ? "בטל" : `הוסף ${fmt(r.quantity)}`}</button></div>; })}
          <button type="button" onClick={addRecommendedPackaging}>הוסף את כל ההמלצות לטיוטה</button>
          <div className="bp-manual-pack"><b>+ הוסף אריזה עצמאית</b><label>מיכל<select value={manualPack.tankId} onChange={(e) => updateManualTank(e.target.value)}><option value="">בחר מיכל</option>{tanks.filter((t) => t.ready <= model.weekEnd && t.liters >= 20).map((t) => <option value={t.id} key={t.id}>מיכל {t.number} · {displayStyle(t.style)} · {fmt(t.liters)} ל׳</option>)}</select></label><label>פורמט<select value={manualPack.productId} disabled={!manualPack.tankId} onChange={(e) => updateManualProduct(e.target.value)}><option value="">בחר</option>{manualProductsForTank(manualPack.tankId).map((p) => <option value={p.id} key={p.id}>{p.type === "crates" ? "ארגזים" : "חביות"}</option>)}</select></label><label>כמות<input type="number" min="0" value={manualPack.quantity || ""} onChange={(e) => setManualPack((d) => ({ ...d, quantity: Math.max(0, Number(e.target.value)) }))}/></label></div>
        </div>}
        <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={savePackaging}>שמירת החלטת האריזה</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !model.packagingRecommendation.length} onClick={acceptPackagingRecommendation}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => beginEdit("packaging")}>עריכת האריזות</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{model.availableBrewTanks} מיכלים זמינים לפי ההחלטות</b></header>
        <p className="bp-rec-principle">הבישול מחושב אחרי החלטות המשלוח והאריזה. המתכנן בוחר מה לבשל; מנהל העבודה ישבץ אחר כך מיכל ויום.</p>
        <div className="bp-decided-list"><b>המלצת המערכת</b>{model.brewRecommendations.length ? model.brewRecommendations.map((r, i) => <div className="bp-rec-line" key={`${r.style}:${i}`}><span><b>{displayStyle(r.style)}</b></span><span>{fmt(r.liters)} ל׳</span></div>) : <small>אין כרגע המלצת בישול נוספת.</small>}</div>
        <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.length ? current.brews.map((b) => <div className="bp-rec-line" key={b.id}><span><b>{displayStyle(b.style)}</b></span><span>{fmt(b.liters)} ל׳</span></div>) : <small>טרם נקבעו בישולים.</small>}</div>
        {editing === "brew" && <div className="bp-decided-list"><b>עריכת החלטת הבישול</b>{brewDraft.map((b, i) => <div className="bp-brew-edit-row" key={i}><select value={b.style} onChange={(e) => setBrewDraft((d) => d.map((x, j) => j === i ? { ...x, style: e.target.value } : x))}>{CORE_STYLES.map((s) => <option value={s} key={s}>{displayStyle(s)}</option>)}</select><input type="number" min="1" value={b.liters} onChange={(e) => setBrewDraft((d) => d.map((x, j) => j === i ? { ...x, liters: Number(e.target.value) } : x))}/><button onClick={() => setBrewDraft((d) => d.filter((_, j) => j !== i))}>הסר</button></div>)}<button onClick={() => setBrewDraft((d) => [...d, { style: model.brewRecommendations[d.length]?.style ?? CORE_STYLES[0], liters: model.brewRecommendations[d.length]?.liters ?? 2500 }])}>+ הוסף בישול</button></div>}
        <div className="bp-actions">{editing === "brew" ? <><button disabled={busy} onClick={saveBrews}>שמירת החלטת הבישול</button><button onClick={() => setEditing(null)}>ביטול</button></> : <button disabled={disabled || busy} onClick={() => beginEdit("brew")}>עריכת הבישולים</button>}</div>
      </article>
    </div>
  </section>;
}

function requireTruckCapacity() {
  // Static helper wrapper keeps all slot calculations in the same project utility.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../SERVICES/cooler/truckCapacity") as typeof import("../../SERVICES/cooler/truckCapacity");
}
