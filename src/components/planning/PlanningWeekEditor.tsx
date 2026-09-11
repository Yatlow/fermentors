import { useMemo, useState } from "react";
import { litersPerUnit, sameStyle, type Settings, type Tank, type WeekPlan, type BrewPlan, type Plan } from "../../SERVICES/planning/planningEngine";
import type { Fermentor } from "../../App";
import PlanningDaySelect from "./PlanningDaySelect";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { packagingLimit } from "../../SERVICES/planning/productionCycle";

export default function PlanningWeekEditor({ initial, day, settings, tanks, brews, disabled, onSave, onCancel }: {
  initial: WeekPlan; day: string; settings: Settings; tanks: Tank[]; brews: Fermentor[]; disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => {
    const copy = structuredClone(initial);
    copy.packaging = copy.packaging.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
    return copy;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dayPacks = draft.packaging.map((r, i) => ({ r, i })).filter(({ r }) => r.date === day);
  const dayBrews = draft.brews.map((b, i) => ({ b, i })).filter(({ b }) => b.date === day);
  const dayDeliveries = (draft.deliveries ?? []).map((d, i) => ({ d, i })).filter(({ d }) => d.dispatchDate === day);
  const styles = useMemo(() => [...new Set(settings.products.filter((p) => !p.id.startsWith("special:")).map((p) => p.style))], [settings]);

  const usedLiters = (tankId: string, exceptId?: string) => draft.packaging
    .filter((r) => r.tankId === tankId && r.id !== exceptId)
    .reduce((sum, r) => {
      const p = settings.products.find((p) => p.id === r.productId);
      return sum + (p ? r.quantity * litersPerUnit(p) : 0);
    }, 0);

  function suggestedQuantity(tankId: string, productId: string, id?: string) {
    const tank = tanks.find((t) => t.id === tankId);
    const product = settings.products.find((p) => p.id === productId);
    if (!tank || !product || !sameStyle(tank.style, product.style)) return 0;
    const remaining = Math.max(0, tank.liters - usedLiters(tankId, id));
    return Math.max(0, Math.floor(Math.min(remaining / litersPerUnit(product), packagingLimit(day, product.type))));
  }
  const updatePack = (i: number, patch: Partial<Plan>) => setDraft((w) => ({ ...w, packaging: w.packaging.map((r, j) => j === i ? { ...r, ...patch } : r) }));
  const updateBrew = (i: number, patch: Partial<BrewPlan>) => setDraft((w) => ({ ...w, brews: w.brews.map((r, j) => j === i ? { ...r, ...patch } : r) }));

  async function save() {
    setBusy(true); setError("");
    try {
      await onSave({ ...draft, changeReason: draft.changeReason?.trim() || "עדכון לוח העבודה", packaging: draft.packaging.map((r) => {
        const tank = tanks.find((t) => t.id === r.tankId);
        return tank ? { ...r, tankNumber: tank.number, batchNumber: tank.batch } : r;
      }) });
    } catch (e) { setError(e instanceof Error ? e.message : "השמירה נכשלה"); }
    finally { setBusy(false); }
  }

  function addPackaging() {
    const tank = tanks.find((t) => t.ready <= day && t.liters - usedLiters(t.id) >= 20);
    const product = tank && settings.products.find((p) => !p.id.startsWith("special:") && sameStyle(p.style, tank.style));
    const id = crypto.randomUUID();
    const quantity = tank && product ? suggestedQuantity(tank.id, product.id, id) : 0;
    setDraft((w) => ({ ...w, packaging: [...w.packaging, { id, productId: product?.id ?? settings.products[0]?.id ?? "", tankId: tank?.id ?? "", quantity, date: day, source: "manual" }] }));
  }

  return <section className="bp-editor" aria-label="עריכת היום">
    <div className="bp-section-heading"><div><h3>עריכת {shortDate(day)}</h3><small>שינוי יום פעולה מעביר אותה ליום אחר בלוח.</small></div><button onClick={onCancel}>סגירה</button></div>
    <fieldset disabled={disabled || busy} className="bp-fieldset">
      <label><input type="checkbox" checked={(draft.deliveryDates ?? []).includes(day)} onChange={(e) => setDraft((w) => ({ ...w, deliveryDates: e.target.checked ? [...new Set([...(w.deliveryDates ?? []), day])].sort() : (w.deliveryDates ?? []).filter((d) => d !== day) }))}/>ביום הזה מגיע איסוף לטמפו</label>

      <h4>אריזות</h4>
      {dayPacks.map(({ r, i }) => {
        const tank = tanks.find((t) => t.id === r.tankId);
        const products = settings.products.filter((p) => !p.id.startsWith("special:") && (!tank || sameStyle(p.style, tank.style)));
        const max = r.tankId ? suggestedQuantity(r.tankId, r.productId, r.id) : 0;
        return <div className="bp-edit-card" key={r.id}>
          <div className="bp-fields">
            <label>מיכל<select value={r.tankId ?? ""} onChange={(e) => {
              const nextTank = tanks.find((t) => t.id === e.target.value);
              const nextProduct = settings.products.find((p) => nextTank && sameStyle(p.style, nextTank.style) && !p.id.startsWith("special:"));
              updatePack(i, { tankId: e.target.value, productId: nextProduct?.id ?? r.productId, quantity: nextProduct ? suggestedQuantity(e.target.value, nextProduct.id, r.id) : 0 });
            }}><option value="">בחירת מיכל</option>{tanks.filter((t) => t.ready <= day).map((t) => <option key={t.id} value={t.id}>{t.number} · {t.style} · {Math.floor(Math.max(0, t.liters - usedLiters(t.id, r.id)))} ל׳ זמינים</option>)}</select></label>
            <label>מה אורזים<select value={r.productId} onChange={(e) => updatePack(i, { productId: e.target.value, quantity: suggestedQuantity(r.tankId ?? "", e.target.value, r.id) })}>{products.map((p) => <option key={p.id} value={p.id}>{p.type === "crates" ? "בקבוקים" : "חביות"} · {p.style}</option>)}</select></label>
            <label>כמות<input type="number" min="1" max={max || undefined} value={r.quantity} onChange={(e) => updatePack(i, { quantity: Math.min(Number(e.target.value), max || Number(e.target.value)) })}/>{max > 0 && <small>מקסימום מחושב: {max}</small>}</label>
            <PlanningDaySelect week={draft.id} allowWeekend={draft.allowExceptions} value={r.date ?? day} label="העברת האריזה ליום אחר" onChange={(date) => updatePack(i, { date })}/>
          </div>
          <label><input type="checkbox" checked={r.emptyTank ?? false} onChange={(e) => updatePack(i, { emptyTank: e.target.checked })}/>זו האריזה האחרונה מהמיכל</label>
          <button onClick={() => setDraft((w) => ({ ...w, packaging: w.packaging.filter((_, j) => i !== j) }))}>הסרת האריזה</button>
        </div>;
      })}
      <button onClick={addPackaging}>הוספת אריזה</button>

      <h4>בישולים</h4>
      {dayBrews.map(({ b, i }) => <div className="bp-edit-card" key={b.id}><div className="bp-fields">
        <label>סגנון<select value={b.style} onChange={(e) => updateBrew(i, { style: e.target.value })}>{styles.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>מיכל<select value={b.tankId} onChange={(e) => updateBrew(i, { tankId: e.target.value, liters: Number(brews.find((t) => t.id === e.target.value)?.beerVolume) || b.liters })}><option value="">בחירת מיכל</option>{brews.filter((t) => Number(t.tankNumber) !== 1).map((t) => <option key={t.id} value={t.id}>{t.tankNumber ?? t.id}{Number(t.action) === 0 ? " · מחכה לבישול" : ""}</option>)}</select></label>
        <label>ליטרים<input type="number" min="1" value={b.liters} onChange={(e) => updateBrew(i, { liters: Number(e.target.value) })}/></label>
        <PlanningDaySelect week={draft.id} allowWeekend={draft.allowExceptions} value={b.date} label="העברת הבישול ליום אחר" onChange={(date) => updateBrew(i, { date })}/>
      </div><button onClick={() => setDraft((w) => ({ ...w, brews: w.brews.filter((_, j) => i !== j) }))}>הסרת הבישול</button></div>)}
      <button onClick={() => setDraft((w) => ({ ...w, brews: [...w.brews, { id: crypto.randomUUID(), tankId: "", style: styles[0] ?? "", date: day, liters: 0 }] }))}>הוספת בישול</button>

      <h4>משלוח</h4>
      {dayDeliveries.length ? <div className="bp-edit-card"><b>משלוח אחד · {dayDeliveries.length} מוצרים</b>{dayDeliveries.map(({ d, i }) => <div className="bp-shipment-row" key={d.id}><span>{settings.products.find((p) => p.id === d.productId)?.style ?? d.productId} · {d.quantity}</span><button onClick={() => setDraft((w) => ({ ...w, deliveries: (w.deliveries ?? []).filter((_, j) => i !== j) }))}>הסר</button></div>)}</div> : <p className="bp-muted">לא נקבעה תכולת משלוח ליום זה.</p>}

      <div className="bp-settings"><label><input type="checkbox" checked={draft.allowExceptions ?? false} onChange={(e) => setDraft({ ...draft, allowExceptions: e.target.checked })}/>חריגה משגרת ימי העבודה / קיבולת</label><label>הערה / סיבת שינוי<textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value, changeReason: "שינוי ידני בלוח העבודה" })}/></label></div>
      {error && <p role="alert" className="bp-alert">{error}</p>}
      <div className="bp-actions"><button onClick={save}>{busy ? "שומר…" : "שמירת השינויים"}</button><button onClick={onCancel}>ביטול</button></div>
    </fieldset>
  </section>;
}
