import { useState } from "react";
import {
  type Settings,
  type Tank,
  type WeekPlan,
  type BrewPlan,
  type Plan,
  type DeliveryPlan,
} from "../../SERVICES/planning/planningEngine";
import type { Fermentor } from "../../App";
import PlanningDateInput from "./PlanningDateInput";

export default function PlanningWeekEditor({
  initial,
  settings,
  tanks,
  brews,
  disabled,
  onSave,
  onCancel,
}: {
  initial: WeekPlan;
  settings: Settings;
  tanks: Tank[];
  brews: Fermentor[];
  disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const products = settings.products.map((p) => (
    <option key={p.id} value={p.id}>
      {p.style} · {p.type === "crates" ? "ארגזים" : "חביות"}
    </option>
  ));
  const updatePack = (i: number, patch: Partial<Plan>) =>
    setDraft((w) => ({
      ...w,
      packaging: w.packaging.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  const updateBrew = (i: number, patch: Partial<BrewPlan>) =>
    setDraft((w) => ({
      ...w,
      brews: w.brews.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  const updateDelivery = (i: number, patch: Partial<DeliveryPlan>) =>
    setDraft((w) => ({
      ...w,
      deliveries: (w.deliveries ?? []).map((r, j) =>
        j === i ? { ...r, ...patch } : r,
      ),
    }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...draft,
        changeReason: draft.changeReason?.trim() || "עדכון לוח העבודה",
        packaging: draft.packaging.map((r) => {
          const tank = tanks.find((t) => t.id === r.tankId);
          return tank
            ? { ...r, tankNumber: tank.number, batchNumber: tank.batch }
            : r;
        }),
        deliveries:
          draft.deliveries?.map((d) => ({
            ...d,
            arrivalDate: d.dispatchDate,
          })) ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="bp-editor" aria-label="עריכת השבוע">
      <h3>החלטות לשבוע</h3>
      <fieldset disabled={disabled || busy} className="bp-fieldset">
        <h4>ימי איסוף לטמפו</h4>
        {(draft.deliveryDates ?? []).map((date, i) => (
          <div className="bp-fields" key={i}>
            <PlanningDateInput
              value={date}
              onChange={(date) =>
                setDraft({
                  ...draft,
                  deliveryDates: draft.deliveryDates!.map((d, j) =>
                    i === j ? date : d,
                  ),
                })
              }
            />
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  deliveryDates: draft.deliveryDates!.filter((_, j) => i !== j),
                })
              }
            >
              הסרת יום איסוף
            </button>
          </div>
        ))}
        <div className="bp-actions">
          <button
            onClick={() =>
              setDraft({
                ...draft,
                deliveryDates: [...(draft.deliveryDates ?? []), draft.id],
              })
            }
          >
            הוספת יום איסוף
          </button>
          <button onClick={() => setDraft({ ...draft, deliveryDates: [] })}>
            השבוע אין איסוף
          </button>
          <button
            onClick={() => {
              const next = { ...draft };
              delete next.deliveryDates;
              setDraft(next);
            }}
          >
            השארת מועד מוצע
          </button>
        </div>
        <h4>אריזות</h4>
        {draft.packaging.map((r, i) => (
          <div className="bp-edit-card" key={r.id ?? i}>
            <div className="bp-fields">
              <label>
                מוצר
                <select
                  value={r.productId}
                  onChange={(e) => updatePack(i, { productId: e.target.value })}
                >
                  {products}
                </select>
              </label>
              <label>
                כמות
                <input
                  type="number"
                  min="0"
                  value={r.quantity}
                  onChange={(e) =>
                    updatePack(i, { quantity: Number(e.target.value) })
                  }
                />
              </label>
              <PlanningDateInput
                value={r.date ?? ""}
                onChange={(date) => updatePack(i, { date })}
              />
              <label>
                מיכל
                <select
                  value={r.tankId ?? ""}
                  onChange={(e) => updatePack(i, { tankId: e.target.value })}
                >
                  <option value="">בחירת מיכל</option>
                  {tanks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.number} · {t.style} · {Math.floor(t.liters)} ל׳
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              <input
                type="checkbox"
                checked={r.emptyTank ?? false}
                onChange={(e) => updatePack(i, { emptyTank: e.target.checked })}
              />
              המיכל מסתיים באריזה הזאת, כולל שארית קטנה מ־20 ל׳
            </label>
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  packaging: draft.packaging.filter((_, j) => i !== j),
                })
              }
            >
              הסרת האריזה
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              packaging: [
                ...draft.packaging,
                {
                  id: crypto.randomUUID(),
                  productId: settings.products[0]?.id ?? "",
                  quantity: 84,
                  date: draft.id,
                  source: "manual",
                },
              ],
            })
          }
        >
          הוספת אריזה
        </button>
        <h4>בישולים</h4>
        {draft.brews.map((b, i) => (
          <div className="bp-edit-card" key={b.id}>
            <div className="bp-fields">
              <label>
                סגנון
                <select
                  value={b.style}
                  onChange={(e) => updateBrew(i, { style: e.target.value })}
                >
                  {[...new Set(settings.products.map((p) => p.style))].map(
                    (s) => (
                      <option key={s}>{s}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                מיכל
                <select
                  value={b.tankId}
                  onChange={(e) =>
                    updateBrew(i, {
                      tankId: e.target.value,
                      liters:
                        Number(
                          brews.find((t) => t.id === e.target.value)
                            ?.beerVolume,
                        ) || 0,
                    })
                  }
                >
                  <option value="">בחירת מיכל</option>
                  {brews
                    .filter((t) => Number(t.tankNumber) !== 1)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.tankNumber ?? t.id}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                ליטרים
                <input
                  type="number"
                  min="1"
                  value={b.liters}
                  onChange={(e) =>
                    updateBrew(i, { liters: Number(e.target.value) })
                  }
                />
              </label>
              <PlanningDateInput
                value={b.date}
                onChange={(date) => updateBrew(i, { date })}
              />
            </div>
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  brews: draft.brews.filter((_, j) => i !== j),
                })
              }
            >
              הסרת הבישול
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              brews: [
                ...draft.brews,
                {
                  id: crypto.randomUUID(),
                  tankId: "",
                  style: settings.products[0]?.style ?? "",
                  date: draft.id,
                  liters: 0,
                },
              ],
            })
          }
        >
          הוספת בישול
        </button>
        <h4>תכולת משלוחים שנקבעה</h4>
        {(draft.deliveries ?? []).map((d, i) => (
          <div className="bp-edit-card" key={d.id}>
            <div className="bp-fields">
              <label>
                מוצר
                <select
                  value={d.productId}
                  onChange={(e) =>
                    updateDelivery(i, {
                      productId: e.target.value,
                      pallets: [],
                    })
                  }
                >
                  {products}
                </select>
              </label>
              <label>
                כמות
                <input
                  type="number"
                  min="1"
                  value={d.quantity}
                  onChange={(e) =>
                    updateDelivery(i, {
                      quantity: Number(e.target.value),
                      pallets: [],
                    })
                  }
                />
              </label>
              <PlanningDateInput
                value={d.dispatchDate}
                label="יום איסוף וקליטה"
                onChange={(dispatchDate) =>
                  updateDelivery(i, { dispatchDate, arrivalDate: dispatchDate })
                }
              />
            </div>
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  deliveries: draft.deliveries!.filter((_, j) => i !== j),
                })
              }
            >
              הסרת המשלוח
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              deliveries: [
                ...(draft.deliveries ?? []),
                {
                  id: crypto.randomUUID(),
                  productId: settings.products[0]?.id ?? "",
                  quantity: 84,
                  dispatchDate: draft.id,
                  arrivalDate: draft.id,
                },
              ],
            })
          }
        >
          הוספת תכולת משלוח
        </button>
        <div className="bp-settings">
          <label>
            <input
              type="checkbox"
              checked={draft.allowExceptions ?? false}
              onChange={(e) =>
                setDraft({ ...draft, allowExceptions: e.target.checked })
              }
            />
            השבוע נדרשת חריגה משגרת האריזה או ימי העבודה
          </label>
          {draft.allowExceptions && (
            <p>
              מאפשר ימים וכמויות אריזה חריגים ופיצול מיכל ליותר מיומיים. בדיקות
              מלאי וקיבולת המשאית נשארות בתוקף.
            </p>
          )}
          <label>
            הערה / סיבת שינוי
            <textarea
              value={draft.note}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  note: e.target.value,
                  changeReason: "שינוי ידני בלוח העבודה",
                })
              }
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="bp-alert">
            {error}
          </p>
        )}
        <div className="bp-actions">
          <button onClick={save}>{busy ? "שומר…" : "שמירת ההחלטות"}</button>
          <button onClick={onCancel}>סגירה ללא שמירת השינויים</button>
        </div>
      </fieldset>
    </section>
  );
}
