import { useState } from "react";
import {
  litersPerUnit,
  sameStyle,
  num,
  weekNumber,
  type Settings,
  type Tank,
  type WeekPlan,
  type BrewPlan,
  type Plan,
  type DeliveryPlan,
} from "../../SERVICES/planning/planningEngine";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import PlanningDaySelect from "./PlanningDaySelect";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { CORE_STYLES, displayStyle, isCoreStyle } from "../../SERVICES/planning/planningPresentation";
import { estimatedBrewVolume } from "../../SERVICES/planning/productionCycle";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";

export default function PlanningWeekEditor({
  initial,
  day,
  scope = "day",
  defaultBrewDate,
  settings,
  tanks,
  brews,
  pallets,
  disabled,
  onSave,
  onCancel,
}: {
  initial: WeekPlan;
  day: string;
  scope?: "day" | "brews";
  defaultBrewDate?: string;
  settings: Settings;
  tanks: Tank[];
  brews: Fermentor[];
  pallets: Pallet[];
  disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => {
    const copy = structuredClone(initial);
    copy.packaging = copy.packaging.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
    return copy;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [otherStyle, setOtherStyle] = useState("");
  const [deliveryProduct, setDeliveryProduct] = useState("");
  const [deliveryQty, setDeliveryQty] = useState(0);

  const dayPacks = draft.packaging.map((r, i) => ({ r, i })).filter(({ r }) => r.date === day);
  const visibleBrews = draft.brews.map((b, i) => ({ b, i }));
  const dayDeliveries = (draft.deliveries ?? []).map((d, i) => ({ d, i })).filter(({ d }) => d.dispatchDate === day);

  const usedLiters = (tankId: string, exceptId?: string) =>
    draft.packaging
      .filter((r) => r.tankId === tankId && r.id !== exceptId)
      .reduce((sum, r) => {
        const p = settings.products.find((p) => p.id === r.productId);
        return sum + (p ? r.quantity * litersPerUnit(p) : 0);
      }, 0);

  function maxTankQuantity(tankId: string, productId: string, id?: string) {
    const tank = tanks.find((t) => t.id === tankId);
    const product = settings.products.find((p) => p.id === productId);
    if (!tank || !product || !sameStyle(tank.style, product.style)) return 0;
    const remaining = Math.max(0, tank.liters - usedLiters(tankId, id));
    return Math.max(0, Math.floor(remaining / litersPerUnit(product) + 1e-8));
  }

  const updatePack = (i: number, patch: Partial<Plan>) =>
    setDraft((w) => ({ ...w, packaging: w.packaging.map((r, j) => j === i ? { ...r, ...patch } : r) }));
  const updateBrew = (i: number, patch: Partial<BrewPlan>) =>
    setDraft((w) => ({ ...w, brews: w.brews.map((r, j) => j === i ? { ...r, ...patch } : r) }));

  const availableFor = (productId: string) => {
    const product = settings.products.find((p) => p.id === productId);
    if (!product) return { physicalPallets: 0, physicalQty: 0, plannedPallets: 0, plannedQty: 0 };
    const physical = pallets.filter(
      (p) =>
        p.zone !== "shipped" &&
        p.itemType === product.type &&
        sameStyle(p.beerStyle, product.style),
    );
    const plannedQty = draft.packaging
      .filter((p) => p.productId === productId && p.date && p.date >= day)
      .reduce((sum, p) => sum + p.quantity, 0);
    return {
      physicalPallets: physical.length,
      physicalQty: physical.reduce((sum, p) => sum + num(p.quantity), 0),
      plannedPallets: plannedQty > 0 ? projectedPallets(product, plannedQty, `editor:${day}`).length : 0,
      plannedQty,
    };
  };

  function addDelivery() {
    const product = settings.products.find((p) => p.id === deliveryProduct);
    if (!product || deliveryQty <= 0) return;
    setDraft((w) => {
      const deliveries = [...(w.deliveries ?? [])];
      const existing = deliveries.findIndex((d) => d.dispatchDate === day && d.productId === product.id);
      if (existing >= 0) {
        deliveries[existing] = {
          ...deliveries[existing],
          quantity: deliveries[existing].quantity + deliveryQty,
          pallets: [],
        };
      } else {
        const next: DeliveryPlan = {
          id: crypto.randomUUID(),
          productId: product.id,
          quantity: deliveryQty,
          dispatchDate: day,
          arrivalDate: day,
          truckId: `truck:${day}`,
          pallets: [],
        };
        deliveries.push(next);
      }
      return {
        ...w,
        deliveries,
        deliveryDates: [...new Set([...(w.deliveryDates ?? []), day])].sort(),
      };
    });
    setDeliveryQty(0);
  }

  async function save() {
    setBusy(true); setError("");
    try {
      await onSave({
        ...draft,
        changeReason: draft.changeReason?.trim() || "עדכון לוח העבודה",
        packaging: draft.packaging.map((r) => {
          const tank = tanks.find((t) => t.id === r.tankId);
          return tank ? { ...r, tankNumber: tank.number, batchNumber: tank.batch } : r;
        }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally { setBusy(false); }
  }

  function addPackaging() {
    const tank = tanks.find((t) => t.ready <= day && t.liters - usedLiters(t.id) >= 1);
    const product = tank && settings.products.find((p) => isCoreStyle(p.style) && sameStyle(p.style, tank.style));
    const id = crypto.randomUUID();
    const quantity = tank && product ? maxTankQuantity(tank.id, product.id, id) : 0;
    setDraft((w) => ({
      ...w,
      packaging: [...w.packaging, {
        id, productId: product?.id ?? settings.products.find((p) => isCoreStyle(p.style))?.id ?? "",
        tankId: tank?.id ?? "", quantity, date: day, source: "manual",
      }],
    }));
  }

  function addBrew() {
    if (!defaultBrewDate) { setError("אין עוד יום בישול זמין בשבוע הזה"); return; }
    setDraft((w) => ({
      ...w,
      brews: [...w.brews, {
        id: crypto.randomUUID(), tankId: "", style: CORE_STYLES[0],
        date: defaultBrewDate, liters: 0,
      }],
    }));
  }

  return (
    <section className="bp-editor" aria-label={scope === "brews" ? "עריכת בישולים" : "עריכת היום"}>
      <div className="bp-editor-header">
        <div>
          <h3>{scope === "brews" ? `בישולים · שבוע ${weekNumber(draft.id)}` : `עריכת ${shortDate(day)}`}</h3>
          <small>{scope === "brews" ? "הבישול שייך לשבוע. היום הפנימי משמש לתחזית ולשיבוץ של מנהל העבודה." : "שינוי יום פעולה מעביר אותה ליום אחר בלוח."}</small>
        </div>
        <button type="button" onClick={onCancel}>סגירה</button>
      </div>

      <fieldset disabled={disabled || busy} className="bp-fieldset bp-editor-body">
        {scope === "day" && <>
          <label><input type="checkbox" checked={(draft.deliveryDates ?? []).includes(day)} onChange={(e) => setDraft((w) => ({ ...w, deliveryDates: e.target.checked ? [...new Set([...(w.deliveryDates ?? []), day])].sort() : (w.deliveryDates ?? []).filter((d) => d !== day) }))}/>ביום הזה מגיע איסוף לטמפו</label>

          <h4>אריזות</h4>
          {dayPacks.map(({ r, i }) => {
            const tank = tanks.find((t) => t.id === r.tankId);
            const products = settings.products.filter((p) => isCoreStyle(p.style) && (!tank || sameStyle(p.style, tank.style)));
            const max = r.tankId ? maxTankQuantity(r.tankId, r.productId, r.id) : 0;
            return <div className="bp-edit-card" key={r.id}>
              <div className="bp-fields">
                <label>מיכל<select value={r.tankId ?? ""} onChange={(e) => {
                  const nextTank = tanks.find((t) => t.id === e.target.value);
                  const nextProduct = settings.products.find((p) => nextTank && isCoreStyle(p.style) && sameStyle(p.style, nextTank.style));
                  updatePack(i, { tankId: e.target.value, productId: nextProduct?.id ?? r.productId, quantity: nextProduct ? maxTankQuantity(e.target.value, nextProduct.id, r.id) : 0 });
                }}><option value="">בחירת מיכל</option>{tanks.filter((t) => t.ready <= day).map((t) => <option key={t.id} value={t.id}>{t.number} · {displayStyle(t.style)} · {Math.floor(Math.max(0, t.liters - usedLiters(t.id, r.id)))} ל׳</option>)}</select></label>
                <label>מה אורזים<select value={r.productId} onChange={(e) => updatePack(i, { productId: e.target.value, quantity: maxTankQuantity(r.tankId ?? "", e.target.value, r.id) })}>{products.map((p) => <option key={p.id} value={p.id}>{p.type === "crates" ? "בקבוקים" : "חביות"} · {displayStyle(p.style)}</option>)}</select></label>
                <label>כמות<input type="number" min="1" max={max || undefined} value={r.quantity} onChange={(e) => updatePack(i, { quantity: Math.min(Number(e.target.value), max || Number(e.target.value)) })}/>{max > 0 && <small>עד {max} לפי יתרת המיכל.</small>}</label>
                <PlanningDaySelect week={draft.id} allowWeekend={draft.allowExceptions} value={r.date ?? day} label="העברת האריזה ליום אחר" onChange={(date) => updatePack(i, { date })}/>
              </div>
              <label><input type="checkbox" checked={r.emptyTank ?? false} onChange={(e) => updatePack(i, { emptyTank: e.target.checked })}/>זו האריזה האחרונה מהמיכל</label>
              <button type="button" onClick={() => setDraft((w) => ({ ...w, packaging: w.packaging.filter((_, j) => i !== j) }))}>הסרת האריזה</button>
            </div>;
          })}
          <button type="button" onClick={addPackaging}>הוספת אריזה</button>

          <h4>משלוח</h4>
          {dayDeliveries.length ? <div className="bp-edit-card">
            <b>תכולת המשלוח</b>
            {dayDeliveries.map(({ d, i }) => {
              const p = settings.products.find((p) => p.id === d.productId);
              const availability = availableFor(d.productId);
              return <div className="bp-shipment-row bp-shipment-qty-row" key={d.id}>
                <div>
                  <b>{displayStyle(p?.style ?? d.productId)} · {p?.type === "crates" ? "ארגזים" : "חביות"}</b>
                  <small>זמין עכשיו: {availability.physicalPallets} משטחים / {Math.round(availability.physicalQty)} · מתכנון: {availability.plannedPallets} משטחים / {Math.round(availability.plannedQty)}</small>
                </div>
                <input
                  type="number"
                  min="0"
                  value={d.quantity}
                  onChange={(e) => setDraft((w) => ({
                    ...w,
                    deliveries: (w.deliveries ?? []).map((x, j) => j === i ? { ...x, quantity: Math.max(0, Number(e.target.value)), pallets: [] } : x),
                  }))}
                />
                <button type="button" onClick={() => setDraft((w) => ({ ...w, deliveries: (w.deliveries ?? []).filter((_, j) => i !== j) }))}>הסר</button>
              </div>;
            })}
          </div> : <p className="bp-muted">לא נקבעה תכולת משלוח ליום זה.</p>}

          <div className="bp-add-delivery-line">
            <label>הוספת מוצר למשלוח<select value={deliveryProduct} onChange={(e) => setDeliveryProduct(e.target.value)}><option value="">בחירת מוצר</option>{settings.products.filter((p) => p.monthly > 0).map((p) => <option value={p.id} key={p.id}>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}</option>)}</select></label>
            <label>כמות<input type="number" min="0" value={deliveryQty || ""} onChange={(e) => setDeliveryQty(Number(e.target.value))}/></label>
            <button type="button" disabled={!deliveryProduct || deliveryQty <= 0} onClick={addDelivery}>הוסף למשלוח</button>
            {deliveryProduct && (() => { const a = availableFor(deliveryProduct); return <small>המערכת תבחר את המשטחים בפועל לפי FIFO. זמינים כעת {a.physicalPallets} משטחים; עוד {a.plannedPallets} משטחים צפויים מהתכנון.</small>; })()}
          </div>
        </>}

        {scope === "brews" && <>
          <h4>בישולים השבוע</h4>
          {visibleBrews.map(({ b, i }) => {
            const source = brews.find((t) => t.id === b.tankId);
            const explicit = num(source?.beerVolume);
            const estimated = source ? estimatedBrewVolume(source.tankNumber, b.style) : 0;
            const capacity = explicit || estimated;
            const styleIsOther = !CORE_STYLES.some((s) => sameStyle(s, b.style));
            return <div className="bp-edit-card" key={b.id}>
              <div className="bp-fields">
                <label>סגנון<select value={styleIsOther ? "אחר" : displayStyle(b.style)} onChange={(e) => {
                  const value = e.target.value;
                  const style = value === "אחר" ? otherStyle : value;
                  const volume = source ? num(source.beerVolume) || estimatedBrewVolume(source.tankNumber, style) : b.liters;
                  updateBrew(i, { style, liters: volume || b.liters });
                }}>{CORE_STYLES.map((s) => <option key={s} value={s}>{displayStyle(s)}</option>)}<option value="אחר">אחר</option></select></label>
                {(styleIsOther || b.style === "") && <label>סגנון אחר<input value={otherStyle || (styleIsOther ? b.style : "")} onChange={(e) => { setOtherStyle(e.target.value); const volume = source ? num(source.beerVolume) || estimatedBrewVolume(source.tankNumber, e.target.value) : b.liters; updateBrew(i, { style: e.target.value, liters: volume || b.liters }); }}/></label>}
                <label>מיכל<select value={b.tankId} onChange={(e) => {
                  const sourceTank = brews.find((t) => t.id === e.target.value);
                  const volume = sourceTank ? num(sourceTank.beerVolume) || estimatedBrewVolume(sourceTank.tankNumber, b.style) : 0;
                  updateBrew(i, { tankId: e.target.value, liters: volume || b.liters });
                }}><option value="">בחירת מיכל</option>{brews.filter((t) => Number(t.tankNumber) !== 1).map((t) => {
                  const volume = num(t.beerVolume) || estimatedBrewVolume(t.tankNumber, b.style);
                  return <option key={t.id} value={t.id}>{t.tankNumber ?? t.id}{Number(t.action) === 0 ? " · מחכה לבישול" : ""} · {Math.round(volume)} ל׳{num(t.beerVolume) ? "" : " משוער"}</option>;
                })}</select></label>
                <label>נפח בישול<input type="number" min="1" value={b.liters || ""} readOnly={capacity > 0} onChange={(e) => updateBrew(i, { liters: Number(e.target.value) })}/><small>{explicit > 0 ? `מחושב מנפח העבודה של מיכל ${source?.tankNumber ?? ""}` : estimated > 0 ? `משוער לפי ברירות המחדל של גודל מיכל ${source?.tankNumber ?? ""}` : "לא נמצא נפח אוטומטי — אפשר להזין ידנית."}</small></label>
              </div>
              <button type="button" onClick={() => setDraft((w) => ({ ...w, brews: w.brews.filter((_, j) => i !== j) }))}>הסרת הבישול</button>
            </div>;
          })}
          <button type="button" disabled={!defaultBrewDate} onClick={addBrew}>הוספת בישול לשבוע</button>
        </>}

        <div className="bp-settings"><label><input type="checkbox" checked={draft.allowExceptions ?? false} onChange={(e) => setDraft({ ...draft, allowExceptions: e.target.checked })}/>חריגה משגרת ימי העבודה</label><label>הערה / סיבת שינוי<textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value, changeReason: "שינוי ידני בלוח העבודה" })}/></label></div>
        {error && <p role="alert" className="bp-alert">{error}</p>}
      </fieldset>

      <div className="bp-editor-footer"><button type="button" disabled={disabled || busy} onClick={save}>{busy ? "שומר…" : "שמירת השינויים"}</button><button type="button" onClick={onCancel}>ביטול</button></div>
    </section>
  );
}
