import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  sameStyle,
  weeklyDemand,
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
import { openRuns, shortDate, type ShipmentEvent } from "../../SERVICES/planning/dailyPlanner";
import { displayStyle, isCoreStyle, CORE_STYLES } from "../../SERVICES/planning/planningPresentation";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { weekday } from "../../SERVICES/planning/productionCycle";

type Kind = "delivery" | "packaging" | "brew";
type BrewDraft = { style: string; liters: number };
type ManualPackDraft = { id: string; tankId: string; productId: string; quantity: number };

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
  const [manualPacks, setManualPacks] = useState<ManualPackDraft[]>([]);
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

  const currentOpenPackaging = useMemo(
    () => openRuns(plans, settings.products, actuals).filter((r) => r.week === week && r.remaining > 0),
    [plans, settings.products, actuals, week],
  );

  const shipmentProducts = [...products].sort((a, b) => (model.rows.base.get(a.id)?.tempoCover ?? Infinity) - (model.rows.base.get(b.id)?.tempoCover ?? Infinity));
  const packagingProducts = [...products].sort((a, b) => (model.rows.afterShipment.get(a.id)?.totalCover ?? Infinity) - (model.rows.afterShipment.get(b.id)?.totalCover ?? Infinity));

  function currentShipmentQty(productId: string) {
    return (current.deliveries ?? []).filter((d) => d.productId === productId).reduce((s, d) => s + d.quantity, 0);
  }
  function currentPackagingQty(productId: string) {
    return current.packaging.filter((r) => r.productId === productId).reduce((s, r) => s + r.quantity, 0);
  }
  function currentPackagingRemainingQty(productId: string) {
    return currentOpenPackaging.filter((r) => r.productId === productId).reduce((s, r) => s + r.remaining, 0);
  }
  function openRunForSavedPlan(run: Plan) {
    if (run.id) return currentOpenPackaging.find((r) => r.id === run.id);
    return currentOpenPackaging.find((r) => r.productId === run.productId && r.tankId === run.tankId);
  }
  function effectiveSavedRemaining(run: Plan, targetQuantity: number) {
    const open = openRunForSavedPlan(run);
    const completed = Math.max(0, run.quantity - (open?.remaining ?? run.quantity));
    return Math.max(0, targetQuantity - completed);
  }
  function shipmentSlots(draft: Record<string, number>) {
    const manifest = products.flatMap((p) => projectedPallets(p, Math.max(0, draft[p.id] ?? 0), `weekly-edit:${week}:${p.id}`).map((x) => x.pallet));
    if (!manifest.length) return 0;
    try { return calcTruckSlots(manifest); } catch { return Infinity; }
  }
  function physicalInventory(p: Product) {
    return pallets
      .filter((x) => x.zone !== "shipped" && x.itemType === p.type && sameStyle(x.beerStyle, p.style))
      .reduce((s, x) => s + Number(x.quantity || 0), 0);
  }
  function safeShipmentQty(p: Product) {
    const expected = model.rows.base.get(p.id)?.breweryUnits ?? 0;
    return Math.floor(expected / palletSize(p)) * palletSize(p);
  }
  function sameWeekPackagingQty(p: Product) {
    return currentPackagingRemainingQty(p.id);
  }
  function maxShipmentQty(p: Product) {
    const expected = (model.rows.base.get(p.id)?.breweryUnits ?? 0) + sameWeekPackagingQty(p);
    return Math.floor(expected / palletSize(p)) * palletSize(p);
  }
  function riskyShipmentQty(p: Product, quantity: number) {
    return Math.max(0, quantity - safeShipmentQty(p));
  }
  function draftShipmentCover(p: Product) {
    const base = model.rows.base.get(p.id);
    if (!base || base.tempoUnits === null || weeklyDemand(p) <= 0) return null;
    return (base.tempoUnits + (shipDraft[p.id] ?? 0)) / weeklyDemand(p);
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
      setPackDraft(next); setManualPacks([]);
    } else {
      setBrewDraft(current.brews.map((b) => ({ style: b.style, liters: b.liters })));
    }
  }

  function stepShipment(p: Product, delta: number) {
    const step = palletSize(p);
    setShipDraft((prev) => {
      const proposed = Math.max(0, (prev[p.id] ?? 0) + delta * step);
      if (delta > 0 && proposed > maxShipmentQty(p)) {
        setMessage(`אין מספיק מלאי זמין עד השבוע הזה עבור ${displayStyle(p.style)}. כולל אריזה מתוכננת השבוע אפשר עד ${Math.floor(maxShipmentQty(p) / step)} משטחים.`);
        return prev;
      }
      const next = { ...prev, [p.id]: proposed };
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
    const usesSameWeekPackaging = products.some((p) => riskyShipmentQty(p, shipDraft[p.id] ?? 0) > 0);
    setBusy(true); setMessage("");
    try {
      const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
      const deliveries: DeliveryPlan[] = products.flatMap((p) => {
        const quantity = Math.max(0, shipDraft[p.id] ?? 0);
        return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
      });
      await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "עדכון החלטת משלוח שבועית" });
      setEditing(null);
      const partial = slots > 0 && slots < MAX_TRUCK_SLOTS ? ` נשמר משלוח חלקי ${slots}/${MAX_TRUCK_SLOTS}.` : " החלטת המשלוח נשמרה.";
      setMessage(`${partial}${usesSameWeekPackaging ? " ⚠️ ההחלטה כוללת מלאי שייארז באותו שבוע; יש לתאם אריזה לפני/ביום המשלוח." : ""}`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  async function acceptShipmentRecommendation() {
    const date = current.deliveries?.[0]?.dispatchDate ?? addDays(week, 1);
    const deliveries: DeliveryPlan[] = products.flatMap((p) => {
      const quantity = shipmentRec.get(p.id)?.quantity ?? 0;
      return quantity ? [{ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${week}`, pallets: [] }] : [];
    });
    setBusy(true); setMessage("");
    try {
      await saveWeek({ ...current, deliveries, deliveryDates: deliveries.length ? [date] : [], changeReason: "אישור המלצת משלוח שבועית" });
      setMessage("המלצת המשלוח נשמרה כהחלטה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת המשלוח נכשלה"); }
    finally { setBusy(false); }
  }

  function allDraftPackLines() {
    const lines: { tankId?: string; productId: string; quantity: number }[] = [];
    for (const r of current.packaging) {
      const key = r.id ?? `${r.productId}:${r.tankId}`;
      const targetQuantity = Math.max(0, packDraft[key] ?? r.quantity);
      const quantity = effectiveSavedRemaining(r, targetQuantity);
      if (quantity) lines.push({ tankId: r.tankId, productId: r.productId, quantity });
    }
    for (const r of model.packagingRecommendation) {
      const quantity = Math.max(0, packDraft[`rec:${r.id}`] ?? 0);
      if (quantity) lines.push({ tankId: r.tankId, productId: r.productId, quantity });
    }
    for (const r of manualPacks) if (r.tankId && r.productId && r.quantity > 0) lines.push(r);
    return lines;
  }
  function remainingLitersForTank(tankId: string, excludeManualId?: string) {
    const base = model.tankAvailableLiters.get(tankId) ?? tanks.find((t) => t.id === tankId)?.liters ?? 0;
    const used = [
      ...current.packaging.map((r) => {
        const target = Math.max(0, packDraft[r.id ?? `${r.productId}:${r.tankId}`] ?? r.quantity);
        return { id: `saved:${r.id}`, tankId: r.tankId, productId: r.productId, quantity: effectiveSavedRemaining(r, target) };
      }),
      ...model.packagingRecommendation.map((r) => ({ id: `rec:${r.id}`, tankId: r.tankId, productId: r.productId, quantity: Math.max(0, packDraft[`rec:${r.id}`] ?? 0) })),
      ...manualPacks.map((r) => ({ ...r, id: `manual:${r.id}` })),
    ].filter((r) => r.tankId === tankId && (!excludeManualId || r.id !== `manual:${excludeManualId}`));
    return Math.max(0, base - used.reduce((sum, r) => sum + r.quantity * litersPerUnit(product(r.productId)!), 0));
  }
  function manualProductsForTank(tankId: string) {
    const t = tanks.find((x) => x.id === tankId);
    return t ? products.filter((p) => sameStyle(p.style, t.style)) : [];
  }
  function addManualPack() {
    setManualPacks((rows) => [...rows, { id: crypto.randomUUID(), tankId: "", productId: "", quantity: 0 }]);
  }
  function changeManualTank(id: string, tankId: string) {
    setManualPacks((rows) => rows.map((r) => {
      if (r.id !== id) return r;
      const p = manualProductsForTank(tankId)[0];
      const liters = remainingLitersForTank(tankId, id);
      return { ...r, tankId, productId: p?.id ?? "", quantity: p ? Math.floor(liters / litersPerUnit(p)) : 0 };
    }));
  }
  function changeManualProduct(id: string, productId: string) {
    setManualPacks((rows) => rows.map((r) => {
      if (r.id !== id) return r;
      const liters = remainingLitersForTank(r.tankId, id);
      const p = product(productId);
      return { ...r, productId, quantity: p ? Math.floor(liters / litersPerUnit(p)) : 0 };
    }));
  }
  function draftPackagingCover(p: Product) {
    const before = model.rows.afterShipment.get(p.id);
    if (!before || before.tempoUnits === null || weeklyDemand(p) <= 0) return null;
    const planned = allDraftPackLines().filter((r) => r.productId === p.id).reduce((s, r) => s + r.quantity, 0);
    return (before.tempoUnits + before.breweryUnits + planned) / weeklyDemand(p);
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
        const p = product(rec.productId)!;
        packaging.push({ id: rec.id, productId: rec.productId, quantity, tankId: rec.tankId, tankNumber: rec.tankNumber, source: "recommendation", emptyTank: rec.liters - quantity * litersPerUnit(p) < 20 });
      }
      for (const manual of manualPacks) {
        if (!manual.tankId || !manual.productId || manual.quantity <= 0) continue;
        const t = tanks.find((x) => x.id === manual.tankId)!;
        const p = product(manual.productId)!;
        const base = model.tankAvailableLiters.get(t.id) ?? t.liters;
        const usedForTank = packaging.filter((x) => x.tankId === t.id).reduce((sum, x) => sum + effectiveSavedRemaining(x, x.quantity) * litersPerUnit(product(x.productId)!), 0);
        const maxUnits = Math.floor(Math.max(0, base - usedForTank) / litersPerUnit(p));
        const quantity = Math.min(manual.quantity, maxUnits);
        if (!quantity) continue;
        packaging.push({ id: manual.id, productId: p.id, quantity, tankId: t.id, tankNumber: String(t.number), source: "manual", emptyTank: base - usedForTank - quantity * litersPerUnit(p) < 20 });
      }
      await saveWeek({ ...current, packaging, changeReason: "עדכון החלטת אריזה שבועית" });
      setEditing(null); setManualPacks([]); setMessage("החלטת האריזה נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת האריזה נכשלה"); }
    finally { setBusy(false); }
  }

  async function acceptPackagingRecommendation() {
    const packaging: Plan[] = model.packagingRecommendation.map((r) => ({ id: r.id, productId: r.productId, quantity: r.quantity, tankId: r.tankId, tankNumber: r.tankNumber, source: "recommendation", emptyTank: r.liters - r.quantity * litersPerUnit(product(r.productId)!) < 20 }));
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
  async function acceptBrewRecommendations() {
    if (!model.brewRecommendations.length) return;
    const additions = model.brewRecommendations.map((b) => ({
      id: crypto.randomUUID(),
      style: b.style,
      liters: b.liters,
      tankId: "",
      date: addDays(week, 1),
    }));
    setBusy(true); setMessage("");
    try {
      await saveWeek({ ...current, brews: [...current.brews, ...additions], changeReason: "אישור המלצת בישול שבועית" });
      setMessage("המלצות הבישול נוספו לתכנון. את המיכלים והימים תשבץ בלוח העבודה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "שמירת הבישולים נכשלה"); }
    finally { setBusy(false); }
  }
  function addBrew() {
    if (editing !== "brew") {
      setEditing("brew");
      setBrewDraft([...current.brews.map((b) => ({ style: b.style, liters: b.liters })), { style: model.brewRecommendations[0]?.style ?? CORE_STYLES[0], liters: model.brewRecommendations[0]?.liters ?? 2500 }]);
    } else {
      setBrewDraft((d) => [...d, { style: model.brewRecommendations[d.length]?.style ?? CORE_STYLES[0], liters: model.brewRecommendations[d.length]?.liters ?? 2500 }]);
    }
  }
  function pushBrewRecommendationsToDraft() {
    if (!model.brewRecommendations.length) return;
    setEditing("brew");
    setBrewDraft([
      ...current.brews.map((b) => ({ style: b.style, liters: b.liters })),
      ...model.brewRecommendations.map((b) => ({ style: b.style, liters: b.liters })),
    ]);
  }

  const usedShipSlots = editing === "delivery" ? shipmentSlots(shipDraft) : null;
  const riskyShipmentLines = products
    .map((p) => ({ p, quantity: editing === "delivery" ? shipDraft[p.id] ?? 0 : currentShipmentQty(p.id) }))
    .map((x) => ({ ...x, risky: riskyShipmentQty(x.p, x.quantity) }))
    .filter((x) => x.risky > 0);

  return <section className="bp-weekly-planner">
    <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">המערכת מחשבת ומסבירה; המתכנן מחליט. משלוח → אריזה → בישול.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={w === week} onClick={() => { setWeek(w); setEditing(null); setMessage(""); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    {holidaysThisWeek.length > 0 && <div className="bp-week-events"><b>חגים / מגבלות השבוע</b>{holidaysThisWeek.map((h) => <span key={`${h.date}:${h.title}`}>{shortDate(h.date)} · {h.title}{h.closed ? " · סגור" : ""}</span>)}</div>}
    {message && <p role="status" className="bp-week-message">{message}</p>}

    <div className="bp-week-recommendations">
      <article className="bp-week-rec-card bp-week-shipment-card">
        <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{model.shipmentSlots}/{MAX_TRUCK_SLOTS} מקומות בהמלצה</b></header>
        <p className="bp-rec-principle">הכיסוי הוא כיסוי טמפו צפוי לסוף השבוע. "זמין למשלוח" הרגיל לא מניח אריזה של אותו שבוע; המתכנן יכול לחרוג ולשלוח מאריזה שבועית, עם אזהרה מפורשת.</p>
        {editing === "delivery" && <div className="bp-saved-summary"><b>{Number.isFinite(usedShipSlots) ? usedShipSlots : 0}/{MAX_TRUCK_SLOTS} מקומות בשימוש</b> · נותרו {Number.isFinite(usedShipSlots) ? Math.max(0, MAX_TRUCK_SLOTS - Number(usedShipSlots)) : 0}</div>}
        {riskyShipmentLines.length > 0 && <div className="bp-same-week-warning" role="alert"><b>⚠️ משלוח נשען על אריזה של אותו שבוע</b><span>זו חריגה תפעולית: יש לארוז לפני או ביום המשלוח. המערכת מאפשרת לשמור, אבל לא ממליצה על החריגה אוטומטית.</span>{riskyShipmentLines.map(({ p, risky }) => <small key={p.id}>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}: {fmt(risky)} יח׳ מהמשלוח עדיין תלויות באריזה השבוע.</small>)}</div>}
        <div className="bp-shipment-plan-table">
          <div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי</span><span>מומלץ</span><span>החלטה</span></div>
          {shipmentProducts.map((p) => {
            const base = model.rows.base.get(p.id); const after = model.rows.committed.get(p.id); const rec = shipmentRec.get(p.id); const decided = currentShipmentQty(p.id); const decidedPallets = Math.ceil(decided / palletSize(p));
            const physical = physicalInventory(p); const expected = base?.breweryUnits ?? 0; const plannedDelta = expected - physical; const sameWeek = sameWeekPackagingQty(p);
            const draftQuantity = editing === "delivery" ? shipDraft[p.id] ?? 0 : decided;
            const risky = riskyShipmentQty(p, draftQuantity);
            const shownAfter = editing === "delivery" ? draftShipmentCover(p) : after?.tempoCover ?? null;
            return <div className={`bp-shipment-plan-row ${risky > 0 ? "has-same-week-risk" : (shownAfter ?? Infinity) < settings.targetWeeks ? "is-warning" : "is-ok"}`} key={p.id}>
              <span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span>
              <span>{coverLabel(base?.tempoCover ?? null)}<small>זמין רגיל: {fmt(expected)} · פיזי היום {fmt(physical)}{plannedDelta > 0 ? ` · +${fmt(plannedDelta)} מתכנון קודם` : plannedDelta < 0 ? ` · ${fmt(plannedDelta)} מהחלטות קודמות` : ""}</small>{sameWeek > 0 && <small className="bp-risk-text">⚠️ +{fmt(sameWeek)} מתוכננים לאריזה השבוע — אפשריים רק כחריגה</small>}</span>
              <span>{rec?.pallets ?? 0} מש׳<small>{rec?.slots ?? 0} מק׳</small></span>
              <span>{editing === "delivery" ? <div className="bp-stepper"><button onClick={() => stepShipment(p, -1)}>−</button><b>{Math.round((shipDraft[p.id] ?? 0) / palletSize(p))}</b><button onClick={() => stepShipment(p, 1)}>+</button><small>משטחים · אחרי: {coverLabel(shownAfter)}</small>{risky > 0 && <small className="bp-risk-text">⚠️ {fmt(risky)} יח׳ מאריזה השבוע</small>}</div> : <>{decidedPallets} מש׳<small>אחרי החלטה: {coverLabel(shownAfter)}</small>{risky > 0 && <small className="bp-risk-text">⚠️ {fmt(risky)} יח׳ מאריזה השבוע</small>}</>}</span>
            </div>;
          })}
        </div>
        {!model.shipmentCanFillTruck && model.shipmentSlots > 0 && <p className="bp-alert">אין כרגע מספיק מלאי רגיל צפוי כדי להרכיב המלצה של משאית מלאה. עדיין אפשר לשמור החלטה חלקית ידנית.</p>}
        <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={saveShipment}>שמירת החלטת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !model.shipmentCanFillTruck} onClick={acceptShipmentRecommendation}>קבל המלצת 12/12</button><button disabled={disabled || busy} onClick={() => beginEdit("delivery")}>עריכת המשלוח</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{model.packagingDays}/{model.packagingCapacity} ימי אריזה בהמלצה</b></header>
        <p className="bp-rec-principle">ברירת המחדל היא עד 252 ארגזים בריצה. אם 252 ישאירו פחות מ־7% מהמיכל, והמיכל כולו נכנס בעד 270 ארגזים, ההמלצה תסיים את המיכל במקום ליצור ריצת חביות זעירה. אריזה שכבר בוצעה בפועל מופחתת אוטומטית מהיתרה המתוכננת.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי כולל</span><span>מומלץ</span><span>החלטה</span></div>
          {packagingProducts.map((p) => {
            const before = model.rows.afterShipment.get(p.id); const after = model.rows.afterPackaging.get(p.id); const rec = packagingRecByProduct.get(p.id) ?? 0; const decided = currentPackagingQty(p.id); const remaining = currentPackagingRemainingQty(p.id); const completed = Math.max(0, decided - remaining); const shownAfter = editing === "packaging" ? draftPackagingCover(p) : after?.totalCover ?? null;
            return <div className={`bp-shipment-plan-row ${(shownAfter ?? Infinity) < (settings.totalTargetWeeks ?? settings.targetWeeks) ? "is-warning" : "is-ok"}`} key={p.id}><span><b>{displayStyle(p.style)}</b><small>{p.type === "crates" ? "ארגזים" : "חביות"}</small></span><span>{coverLabel(before?.totalCover ?? null)}</span><span>{fmt(rec)}</span><span>{fmt(remaining)}<small>נותר בתכנון · אחרי החלטה: {coverLabel(shownAfter)}</small>{completed > 0 && <small>{fmt(completed)} כבר נארזו בפועל</small>}</span></div>;
          })}
        </div>
        {editing === "packaging" && <div className="bp-decided-list"><b>החלטות קיימות</b>{current.packaging.length ? current.packaging.map((r) => { const p = product(r.productId); const key = r.id ?? `${r.productId}:${r.tankId}`; const value = packDraft[key] ?? r.quantity; const open = openRunForSavedPlan(r); const completed = Math.max(0, r.quantity - (open?.remaining ?? r.quantity)); return <div className="bp-rec-line" key={key}><span><b>{p ? displayStyle(p.style) : r.productId}</b> · מיכל {r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number ?? "—"}{completed > 0 && <small> · {fmt(completed)} כבר בוצעו</small>}</span><input type="number" min={completed} value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(completed, Number(e.target.value)) }))}/><button onClick={() => setPackDraft((d) => ({ ...d, [key]: completed }))}>בטל יתרה</button></div>; }) : <small>אין החלטות אריזה שמורות.</small>}
          <b>המלצות זמינות</b>{model.packagingRecommendation.map((r) => { const p = product(r.productId)!; const key = `rec:${r.id}`; const value = packDraft[key] ?? 0; return <div className="bp-rec-line" key={r.id}><span><b>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}</b> · מיכל {r.tankNumber}</span><input type="number" min="0" value={value} onChange={(e) => setPackDraft((d) => ({ ...d, [key]: Math.max(0, Number(e.target.value)) }))}/><button onClick={() => setPackDraft((d) => ({ ...d, [key]: value ? 0 : r.quantity }))}>{value ? "בטל" : `הוסף ${fmt(r.quantity)}`}</button></div>; })}
          {manualPacks.map((r) => {
            const remaining = r.tankId ? remainingLitersForTank(r.tankId, r.id) : 0;
            return <div className="bp-manual-pack" key={r.id}><label>מיכל<select value={r.tankId} onChange={(e) => changeManualTank(r.id, e.target.value)}><option value="">בחר מיכל</option>{tanks.filter((t) => t.ready <= model.weekEnd && (model.tankAvailableLiters.get(t.id) ?? t.liters) >= 20).map((t) => <option value={t.id} key={t.id}>מיכל {t.number} · {displayStyle(t.style)} · {fmt(model.tankAvailableLiters.get(t.id) ?? t.liters)} ל׳</option>)}</select></label><label>פורמט<select value={r.productId} disabled={!r.tankId} onChange={(e) => changeManualProduct(r.id, e.target.value)}><option value="">בחר</option>{manualProductsForTank(r.tankId).map((p) => <option value={p.id} key={p.id}>{p.type === "crates" ? "ארגזים" : "חביות"}</option>)}</select></label><label>כמות<input type="number" min="0" value={r.quantity || ""} onChange={(e) => setManualPacks((rows) => rows.map((x) => x.id === r.id ? { ...x, quantity: Math.max(0, Number(e.target.value)) } : x))}/><small>יתרה לפני שורה זו: {fmt(remaining)} ל׳</small></label><button type="button" onClick={() => setManualPacks((rows) => rows.filter((x) => x.id !== r.id))}>הסר</button></div>;
          })}
          <button type="button" onClick={addManualPack}>+ הוסף אריזה</button>
        </div>}
        <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={savePackaging}>שמירת החלטת האריזה</button><button onClick={() => { setEditing(null); setManualPacks([]); }}>ביטול</button></> : <><button disabled={disabled || busy || !model.packagingRecommendation.length} onClick={acceptPackagingRecommendation}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => beginEdit("packaging")}>עריכת האריזות</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{model.availableBrewTanks} מיכלים זמינים לפי ההחלטות</b></header>
        <p className="bp-rec-principle">הבישול מחושב אחרי החלטות המשלוח והאריזה. המתכנן בוחר מה לבשל; מנהל העבודה ישבץ אחר כך מיכל ויום.</p>
        <div className="bp-decided-list"><b>המלצת המערכת</b>{model.brewRecommendations.length ? model.brewRecommendations.map((r, i) => <div className="bp-rec-line" key={`${r.style}:${i}`}><span><b>{displayStyle(r.style)}</b></span><span>{fmt(r.liters)} ל׳</span></div>) : <small>אין כרגע המלצת בישול נוספת.</small>}</div>
        <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.length ? current.brews.map((b) => <div className="bp-rec-line" key={b.id}><span><b>{displayStyle(b.style)}</b></span><span>{fmt(b.liters)} ל׳</span></div>) : <small>טרם נקבעו בישולים.</small>}</div>
        {editing === "brew" && <div className="bp-decided-list"><b>עריכת החלטת הבישול</b>{brewDraft.map((b, i) => <div className="bp-brew-edit-row" key={i}><select value={b.style} onChange={(e) => setBrewDraft((d) => d.map((x, j) => j === i ? { ...x, style: e.target.value } : x))}>{CORE_STYLES.map((s) => <option value={s} key={s}>{displayStyle(s)}</option>)}</select><input type="number" min="1" value={b.liters} onChange={(e) => setBrewDraft((d) => d.map((x, j) => j === i ? { ...x, liters: Number(e.target.value) } : x))}/><button onClick={() => setBrewDraft((d) => d.filter((_, j) => j !== i))}>הסר</button></div>)}</div>}
        <div className="bp-actions">{editing === "brew" ? <><button type="button" disabled={!model.brewRecommendations.length} onClick={pushBrewRecommendationsToDraft}>הוסף את ההמלצות לעריכה</button><button type="button" onClick={addBrew}>+ הוסף בישול</button><button disabled={busy} onClick={saveBrews}>שמירת החלטת הבישול</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button type="button" disabled={disabled || busy || !model.brewRecommendations.length} onClick={acceptBrewRecommendations}>קבל המלצות בישול</button><button type="button" disabled={disabled || busy} onClick={addBrew}>+ הוסף בישול</button><button disabled={disabled || busy} onClick={() => beginEdit("brew")}>עריכת הבישולים</button></>}</div>
      </article>
    </div>
  </section>;
}