import { useEffect, useState } from "react";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import { type Product, type Settings, sameStyle } from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { CORE_STYLES, displayStyle, styleGroups } from "../../SERVICES/planning/planningPresentation";

export default function PlanningData({ mode, settings, today, disabled, save }: {
  mode: "data" | "settings";
  settings: Settings;
  today: string;
  disabled: boolean;
  save: (s: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [baseline, setBaseline] = useState(settings);
  const [stockTouched, setStockTouched] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || stockTouched.length > 0;

  useEffect(() => {
    if (!dirty && settings.revision > baseline.revision) {
      setDraft(structuredClone(settings));
      setBaseline(settings);
    }
  }, [settings, baseline.revision, dirty]);

  function update(id: string, patch: Partial<Product>) {
    setDraft((s) => ({ ...s, products: s.products.map((p) => p.id === id ? { ...p, ...patch } : p) }));
  }

  async function submit() {
    if (
      draft.products.some((p) => !Number.isFinite(p.monthly) || p.monthly < 0 || (p.tempo !== null && (!Number.isFinite(p.tempo) || p.tempo < 0)) || !Number.isInteger(p.leadDays) || p.leadDays < 1) ||
      !Number.isFinite(draft.targetWeeks) || draft.targetWeeks < 0.5 || draft.targetWeeks > 12 ||
      !Number.isFinite(draft.totalTargetWeeks) || draft.totalTargetWeeks! < draft.targetWeeks || draft.totalTargetWeeks! > 26
    ) {
      setMessage("בדקו כמויות ויעדי כיסוי. היעד הכולל צריך להיות לפחות יעד טמפו.");
      return;
    }
    setBusy(true);
    try {
      const next = {
        ...draft,
        lossPercent: 10,
        deliveryTransitDays: 0,
        products: draft.products.map((p) => stockTouched.includes(p.id) ? { ...p, tempoDate: today } : p),
      };
      await save(next);
      const saved = { ...next, revision: next.revision + 1 };
      setDraft(saved);
      setBaseline(saved);
      setStockTouched([]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{mode === "data" ? "הזנת נתונים" : "הגדרות תכנון"}</h2>
      {mode === "data" && <p className="bp-muted">כל ששת הסגנונות פתוחים יחד כדי לאפשר מעבר מהיר בין מלאי טמפו וצפי המכירות.</p>}
      <fieldset disabled={disabled || busy} className="bp-fieldset">
        {mode === "data" && (
          <div className="bp-data-grid bp-data-grid-open">
            {styleGroups(draft).map((g) => (
              <article className="bp-card bp-data-card is-open" key={g.key}>
                <h3 className={`bp-data-style ${beerStyleClass(g.style).className}`}>{displayStyle(g.style)}</h3>
                <div className="bp-data-card-body">
                  <div className="bp-formats">
                    {g.products.map((p) => (
                      <div key={p.id}>
                        <h4>{p.type === "crates" ? "בק׳ / ארגזים" : "חביות"}</h4>
                        <div className="bp-fields">
                          <label>מלאי טמפו<input type="number" min="0" value={p.tempo ?? ""} onChange={(e) => {
                            update(p.id, { tempo: e.target.value === "" ? null : Number(e.target.value) });
                            setStockTouched((ids) => [...new Set([...ids, p.id])]);
                          }}/></label>
                          <label>צפי חודשי<input type="number" min="0" value={p.monthly} onChange={(e) => update(p.id, { monthly: Number(e.target.value) })}/></label>
                        </div>
                        <small>{stockTouched.includes(p.id) ? "יישמר כהיום" : p.tempoDate ? `עודכן ${shortDate(p.tempoDate)}` : "טרם נמדד"}</small>
                        <button type="button" disabled={p.tempo === null || stockTouched.includes(p.id)} onClick={() => setStockTouched((ids) => [...new Set([...ids, p.id])])}>נבדק היום</button>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {mode === "settings" && (
          <div className="bp-settings">
            <div className="bp-fields">
              <label>יעד מלאי בטמפו · שבועות<input type="number" min=".5" max="12" step=".5" value={draft.targetWeeks} onChange={(e) => setDraft({ ...draft, targetWeeks: Number(e.target.value) })}/></label>
              <label>יעד כולל טמפו ומבשלה · שבועות<input type="number" min=".5" max="26" step=".5" value={draft.totalTargetWeeks ?? 8.5} onChange={(e) => setDraft({ ...draft, totalTargetWeeks: Number(e.target.value) })}/></label>
              <label>כמה ימי אריזה בשבוע רצוי?<select value={draft.preferredRuns} onChange={(e) => setDraft({ ...draft, preferredRuns: Number(e.target.value) })}>{[3,4,5].map((n) => <option key={n} value={n}>{n} ימים</option>)}</select></label>
            </div>
            <p>יעדי הכיסוי מתייחסים למוצר מוגמר. בירה במיכלים מחושבת בנפרד לצורך המלצות ייצור.</p>
            <h3>ימי הבשלה לפי סגנון</h3>
            <div className="bp-fields">
              {CORE_STYLES.map((style) => <label key={style}>{displayStyle(style)} · ימים מהבישול<input type="number" min="1" value={draft.products.find((p) => sameStyle(p.style, style))?.leadDays ?? 21} onChange={(e) => setDraft((s) => ({ ...s, products: s.products.map((p) => sameStyle(p.style, style) ? { ...p, leadDays: Number(e.target.value) } : p) }))}/></label>)}
            </div>
          </div>
        )}

        {message && <p role="alert">{message}</p>}
        <div className="bp-actions"><button disabled={!dirty} onClick={submit}>{busy ? "שומר…" : mode === "data" ? "שמירת הנתונים" : "שמירת ההגדרות"}</button>{dirty && <button onClick={() => { setDraft(structuredClone(settings)); setBaseline(settings); setStockTouched([]); setMessage(""); }}>ביטול השינויים שלא נשמרו</button>}</div>
      </fieldset>
    </section>
  );
}
