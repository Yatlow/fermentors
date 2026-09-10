import { useEffect, useState } from "react";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
import {
  type Product,
  type Settings,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

export default function PlanningData({
  settings,
  today,
  disabled,
  save,
}: {
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
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(baseline) ||
    stockTouched.length > 0;
  useEffect(() => {
    if (!dirty && settings.revision > baseline.revision) {
      setDraft(structuredClone(settings));
      setBaseline(settings);
    }
  }, [settings, baseline.revision, dirty]);
  function update(id: string, patch: Partial<Product>) {
    setDraft((s) => ({
      ...s,
      products: s.products.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }
  async function submit() {
    if (
      draft.products.some(
        (p) =>
          !Number.isFinite(p.monthly) ||
          p.monthly < 0 ||
          (p.tempo !== null && (!Number.isFinite(p.tempo) || p.tempo < 0)) ||
          !Number.isInteger(p.leadDays) ||
          p.leadDays < 1,
      ) ||
      !Number.isFinite(draft.targetWeeks) ||
      draft.targetWeeks < 0.5 ||
      draft.targetWeeks > 12 ||
      !Number.isFinite(draft.totalTargetWeeks) ||
      draft.totalTargetWeeks! < draft.targetWeeks ||
      draft.totalTargetWeeks! > 26
    ) {
      setMessage(
        "בדקו כמויות ויעדי כיסוי. היעד הכולל צריך להיות לפחות יעד טמפו.",
      );
      return;
    }
    setBusy(true);
    try {
      const next = {
        ...draft,
        lossPercent: 10,
        deliveryTransitDays: 0,
        products: draft.products.map((p) =>
          stockTouched.includes(p.id) ? { ...p, tempoDate: today } : p,
        ),
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
      <h2>עדכון נתונים</h2>
      <p>
        מלאי טמפו בארגזים או בחביות. המדידה מתוארכת להיום כשמעדכנים את המלאי או
        מסמנים שנבדק מחדש.
      </p>
      <fieldset disabled={disabled || busy} className="bp-fieldset">
        <div className="bp-data-grid">
          {draft.products.map((p) => (
            <article className="bp-card" key={p.id}>
              <h3 className={beerStyleClass(p.style).className}>
                {p.style} · {p.type === "crates" ? "ארגזים" : "חביות"}
              </h3>
              <div className="bp-fields">
                <label>
                  מלאי טמפו
                  <input
                    type="number"
                    min="0"
                    value={p.tempo ?? ""}
                    onChange={(e) => {
                      update(p.id, {
                        tempo:
                          e.target.value === "" ? null : Number(e.target.value),
                      });
                      setStockTouched((ids) => [...new Set([...ids, p.id])]);
                    }}
                  />
                </label>
                <label>
                  צפי מכירות לחודש
                  <input
                    type="number"
                    min="0"
                    value={p.monthly}
                    onChange={(e) =>
                      update(p.id, { monthly: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <small>
                {stockTouched.includes(p.id)
                  ? "יישמר כמדידה מהיום"
                  : p.tempoDate
                    ? `מדידה אחרונה: ${shortDate(p.tempoDate)}`
                    : "טרם נמדד"}
              </small>
              <button
                type="button"
                disabled={p.tempo === null || stockTouched.includes(p.id)}
                onClick={() =>
                  setStockTouched((ids) => [...new Set([...ids, p.id])])
                }
              >
                המלאי נבדק היום ללא שינוי
              </button>
            </article>
          ))}
        </div>
        <details className="bp-settings">
          <summary>הגדרות קבועות</summary>
          <div className="bp-fields">
            <label>
              יעד מלאי בטמפו · שבועות
              <input
                type="number"
                min=".5"
                max="12"
                step=".5"
                value={draft.targetWeeks}
                onChange={(e) =>
                  setDraft({ ...draft, targetWeeks: Number(e.target.value) })
                }
              />
            </label>
            <label>
              יעד כולל טמפו ומבשלה · שבועות
              <input
                type="number"
                min=".5"
                max="26"
                step=".5"
                value={draft.totalTargetWeeks ?? 8.5}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    totalTargetWeeks: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              כמה ימי אריזה בשבוע רצוי?
              <select
                value={draft.preferredRuns}
                onChange={(e) =>
                  setDraft({ ...draft, preferredRuns: Number(e.target.value) })
                }
              >
                {[3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} ימים
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>
            יעדי הכיסוי מתייחסים למוצר מוגמר. בירה במיכלים מחושבת בנפרד לצורך
            המלצות ייצור.
          </p>
          <details>
            <summary>זמני הבשלה לפי מוצר</summary>
            {draft.products.map((p) => (
              <label key={p.id}>
                {p.style} · {p.type === "crates" ? "ארגזים" : "חביות"}
                <input
                  type="number"
                  min="1"
                  value={p.leadDays}
                  onChange={(e) =>
                    update(p.id, { leadDays: Number(e.target.value) })
                  }
                />
              </label>
            ))}
          </details>
        </details>
        {message && <p role="alert">{message}</p>}
        <div className="bp-actions">
          <button disabled={!dirty} onClick={submit}>
            {busy ? "שומר…" : "שמירת הנתונים"}
          </button>
          {dirty && (
            <button
              onClick={() => {
                setDraft(structuredClone(settings));
                setBaseline(settings);
                setStockTouched([]);
                setMessage("");
              }}
            >
              ביטול השינויים שלא נשמרו
            </button>
          )}
        </div>
      </fieldset>
    </section>
  );
}
