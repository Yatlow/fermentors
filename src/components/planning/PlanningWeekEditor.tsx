import { useState } from "react";
import {
  addDays,
  litersPerUnit,
  sameStyle,
  weekNumber,
  type Settings,
  type Tank,
  type WeekPlan,
  type BrewPlan,
  type Plan,
} from "../../SERVICES/planning/planningEngine";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import PlanningDaySelect from "./PlanningDaySelect";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { CORE_STYLES, displayStyle, isCoreStyle, WEEK_DAYS } from "../../SERVICES/planning/planningPresentation";
import { estimatedBrewVolume, type Release } from "../../SERVICES/planning/productionCycle";

const tankType = (value: unknown) => {
  const n = Number(value);
  if (n >= 2 && n <= 4) return "בודד";
  if (n >= 5 && n <= 8) return "כפול";
  if (n >= 9) return "משולש";
  return "";
};

export default function PlanningWeekEditor({
  initial,
  day,
  scope = "day",
  defaultBrewDate,
  settings,
  tanks,
  releases,
  brews,
  pallets: _pallets,
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
  releases: Release[];
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
  const [brewRangeStart, setBrewRangeStart] = useState(1);
  const [brewRangeEnd, setBrewRangeEnd] = useState(4);

  const dayPacks = draft.packaging.map((r, i) => ({ r, i })).filter(({ r }) => r.date === day || !r.date);
  const visibleBrews = draft.brews.map((b, i) => ({ b, i }));

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

  function availableSourcesForBrew(brew: BrewPlan, index: number) {
    return brews.filter((source) => {
      if (Number(source.tankNumber) === 1) return false;
      const occupiedByAnotherPlan = draft.brews.some((other, j) => j !== index && !!other.tankId && other.tankId === source.id);
      if (occupiedByAnotherPlan) return false;
      if (source.id === brew.tankId) return true;
      const release = releases.find((r) => r.tankId === source.id);
      return !!release?.date && release.date <= brew.date;
    });
  }

  function releaseVolume(tankId: string, style: string) {
    const release = releases.find((r) => r.tankId === tankId);
    const source = brews.find((t) => t.id === tankId);
    return release?.workLiters || estimatedBrewVolume(source?.tankNumber, style);
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
    const preferred = Array.from({ length: brewRangeEnd - brewRangeStart + 1 }, (_, i) => addDays(draft.id, brewRangeStart + i))
      .find((date) => date >= defaultBrewDate) ?? addDays(draft.id, brewRangeStart);
    setDraft((w) => ({
      ...w,
      brews: [...w.brews, {
        id: crypto.randomUUID(), tankId: "", style: CORE_STYLES[0],
        date: preferred, liters: 0,
      }],
    }));
  }

  const brewDays = Array.from({ length: Math.max(0, brewRangeEnd - brewRangeStart + 1) }, (_, i) => brewRangeStart + i);

  return (
    <section className="bp-editor" aria-label={scope === "brews" ? "עריכת בישולים" : "עריכת אריזות היום"}>
      <div className="bp-editor-header">
        <div>
          <h3>{scope === "brews" ? `בישולים · שבוע ${weekNumber(draft.id)}` : `אריזות · ${shortDate(day)}`}</h3>
          <small>{scope === "brews" ? "כאן משבצים את החלטות הבישול השבועיות למיכלים פנויים/מתוכננים להתפנות וליום ביצוע." : "הטבלה היומית עוסקת באריזות בלבד."}</small>
        </div>
        <button type="button" onClick={onCancel}>סגירה</button>
      </div>

      <fieldset disabled={disabled || busy} className="bp-fieldset bp-editor-body">
        {scope === "day" && <>
          <h4>אריזות</h4>
          {dayPacks.length === 0 && <p className="bp-muted">אין אריזות ליום הזה ואין אריזות שממתינות לשיבוץ.</p>}
          {dayPacks.map(({ r, i }) => {
            const tank = tanks.find((t) => t.id === r.tankId);
            const products = settings.products.filter((p) => isCoreStyle(p.style) && (!tank || sameStyle(p.style, tank.style)));
            const max = r.tankId ? maxTankQuantity(r.tankId, r.productId, r.id) : 0;
            return <div className="bp-edit-card" key={r.id}>
              {!r.date && <div className="bp-alert"><b>טרם שובץ ליום</b> · <button type="button" onClick={() => updatePack(i, { date: day })}>שבץ ל־{shortDate(day)}</button></div>}
              <div className="bp-fields">
                <label>מיכל<select value={r.tankId ?? ""} onChange={(e) => {
                  const nextTank = tanks.find((t) => t.id === e.target.value);
                  const nextProduct = settings.products.find((p) => nextTank && isCoreStyle(p.style) && sameStyle(p.style, nextTank.style));
                  updatePack(i, { tankId: e.target.value, productId: nextProduct?.id ?? r.productId, quantity: nextProduct ? maxTankQuantity(e.target.value, nextProduct.id, r.id) : 0 });
                }}><option value="">בחירת מיכל</option>{tanks.filter((t) => t.ready <= day).map((t) => <option key={t.id} value={t.id}>{t.number} · {displayStyle(t.style)} · {Math.floor(Math.max(0, t.liters - usedLiters(t.id, r.id)))} ל׳</option>)}</select></label>
                <label>מה אורזים<select value={r.productId} onChange={(e) => updatePack(i, { productId: e.target.value, quantity: maxTankQuantity(r.tankId ?? "", e.target.value, r.id) })}>{products.map((p) => <option key={p.id} value={p.id}>{p.type === "crates" ? "בקבוקים" : "חביות"} · {displayStyle(p.style)}</option>)}</select></label>
                <label>כמות<input type="number" min="1" max={max || undefined} value={r.quantity} onChange={(e) => updatePack(i, { quantity: Math.min(Number(e.target.value), max || Number(e.target.value)) })}/>{max > 0 && <small>עד {max} לפי יתרת המיכל.</small>}</label>
                <PlanningDaySelect week={draft.id} allowWeekend={draft.allowExceptions} value={r.date ?? ""} label="יום האריזה" onChange={(date) => updatePack(i, { date })}/>
              </div>
              <label><input type="checkbox" checked={r.emptyTank ?? false} onChange={(e) => updatePack(i, { emptyTank: e.target.checked })}/>זו האריזה האחרונה מהמיכל</label>
              <button type="button" onClick={() => setDraft((w) => ({ ...w, packaging: w.packaging.filter((_, j) => i !== j) }))}>הסרת האריזה</button>
            </div>;
          })}
          <button type="button" onClick={addPackaging}>הוספת אריזה ליום הזה</button>
        </>}

        {scope === "brews" && <>
          <div className="bp-settings">
            <b>טווח ימי בישול</b>
            <label>מיום<select value={brewRangeStart} onChange={(e) => setBrewRangeStart(Math.min(Number(e.target.value), brewRangeEnd))}>{WEEK_DAYS.slice(0, 5).map((name, i) => <option value={i} key={name}>{name}</option>)}</select></label>
            <label>עד יום<select value={brewRangeEnd} onChange={(e) => setBrewRangeEnd(Math.max(Number(e.target.value), brewRangeStart))}>{WEEK_DAYS.slice(0, 5).map((name, i) => <option value={i} key={name}>{name}</option>)}</select></label>
            <small>ברירת מחדל: שני–חמישי. אפשר להרחיב/לצמצם בתוך שבוע העבודה.</small>
          </div>

          <h4>בישולים השבוע</h4>
          {visibleBrews.map(({ b, i }) => {
            const source = brews.find((t) => t.id === b.tankId);
            const available = availableSourcesForBrew(b, i);
            const unassignedAvailable = available.filter((t) => t.id !== b.tankId);
            const capacity = b.tankId ? releaseVolume(b.tankId, b.style) : 0;
            const styleIsOther = !CORE_STYLES.some((s) => sameStyle(s, b.style));
            const counts = { single: 0, double: 0, triple: 0 };
            for (const t of unassignedAvailable) {
              const type = tankType(t.tankNumber);
              if (type === "בודד") counts.single++;
              if (type === "כפול") counts.double++;
              if (type === "משולש") counts.triple++;
            }
            return <div className="bp-edit-card" key={b.id}>
              <div className="bp-saved-summary">{b.tankId ? `שובץ למיכל ${source?.tankNumber ?? b.tankId} · ` : ""}פנויים נוספים ל־{shortDate(b.date)}: בודד {counts.single} · כפול {counts.double} · משולש {counts.triple}</div>
              <div className="bp-fields">
                <label>סגנון<select value={styleIsOther ? "אחר" : displayStyle(b.style)} onChange={(e) => {
                  const value = e.target.value;
                  const style = value === "אחר" ? otherStyle : value;
                  const volume = b.tankId ? releaseVolume(b.tankId, style) : b.liters;
                  updateBrew(i, { style, liters: volume || b.liters });
                }}>{CORE_STYLES.map((s) => <option key={s} value={s}>{displayStyle(s)}</option>)}<option value="אחר">אחר</option></select></label>
                {(styleIsOther || b.style === "") && <label>סגנון אחר<input value={otherStyle || (styleIsOther ? b.style : "")} onChange={(e) => { setOtherStyle(e.target.value); const volume = b.tankId ? releaseVolume(b.tankId, e.target.value) : b.liters; updateBrew(i, { style: e.target.value, liters: volume || b.liters }); }}/></label>}
                <label>יום בישול<select value={b.date} onChange={(e) => {
                  const nextDate = e.target.value;
                  const selectedStillAvailable = availableSourcesForBrew({ ...b, date: nextDate }, i).some((t) => t.id === b.tankId);
                  updateBrew(i, { date: nextDate, ...(b.tankId && !selectedStillAvailable ? { tankId: "" } : {}) });
                }}>{brewDays.map((offset) => <option key={offset} value={addDays(draft.id, offset)}>{WEEK_DAYS[offset]} · {shortDate(addDays(draft.id, offset))}</option>)}</select></label>
                <label>מיכל<select value={b.tankId} onChange={(e) => {
                  const volume = e.target.value ? releaseVolume(e.target.value, b.style) : 0;
                  updateBrew(i, { tankId: e.target.value, liters: volume || b.liters });
                }}><option value="">בחירת מיכל</option>{available.map((t) => {
                  const release = releases.find((r) => r.tankId === t.id);
                  const volume = release?.workLiters || estimatedBrewVolume(t.tankNumber, b.style);
                  return <option key={t.id} value={t.id}>מיכל {t.tankNumber ?? t.id} · {tankType(t.tankNumber)} · {t.id === b.tankId ? "משובץ לבישול הזה" : `פנוי ${release?.date ? `מ־${shortDate(release.date)}` : ""}`} · {Math.round(volume)} ל׳</option>;
                })}</select></label>
                <label>נפח בישול<input type="number" min="1" value={b.liters || ""} readOnly={capacity > 0} onChange={(e) => updateBrew(i, { liters: Number(e.target.value) })}/><small>{capacity > 0 ? `לפי נפח העבודה של מיכל ${source?.tankNumber ?? ""}` : "בחר מיכל לקבלת נפח עבודה אוטומטי."}</small></label>
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
