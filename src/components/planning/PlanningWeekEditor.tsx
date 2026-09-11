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
import PlanningDaySelect from "./PlanningDaySelect";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";

export default function PlanningWeekEditor({
  initial,
  day,
  settings,
  tanks,
  brews,
  disabled,
  onSave,
  onCancel,
}: {
  initial: WeekPlan;
  day: string;
  settings: Settings;
  tanks: Tank[];
  brews: Fermentor[];
  disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => {
    const copy = structuredClone(initial);
    copy.packaging = copy.packaging.map((r) => ({
      ...r,
      id: r.id ?? crypto.randomUUID(),
    }));
    return copy;
  });
  const [editingIds, setEditingIds] = useState(
    () =>
      new Set([
        ...draft.packaging.filter((r) => r.date === day).map((r) => r.id),
        ...draft.brews.filter((b) => b.date === day).map((b) => b.id),
        ...(draft.deliveries ?? [])
          .filter((d) => d.dispatchDate === day)
          .map((d) => d.id),
      ]),
  );
  function newRowId() {
    const id = crypto.randomUUID();
    setEditingIds((ids) => new Set([...ids, id]));
    return id;
  }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const products = settings.products
    .filter((p) => !p.id.startsWith("special:"))
    .map((p) => (
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
    <section className="bp-editor" aria-label="עריכת היום">
      <h3>
        עריכת יום <bdi>{shortDate(day)}</bdi>
      </h3>
      <fieldset disabled={disabled || busy} className="bp-fieldset">
        <label>
          <input
            type="checkbox"
            checked={(draft.deliveryDates ?? []).includes(day)}
            onChange={(e) =>
              setDraft((w) => ({
                ...w,
                deliveryDates: e.target.checked
                  ? [...new Set([...(w.deliveryDates ?? []), day])].sort()
                  : (w.deliveryDates ?? []).filter((d) => d !== day),
              }))
            }
          />
          ביום הזה מגיע איסוף לטמפו
        </label>
        <h4>אריזות</h4>
        {draft.packaging.map(
          (r, i) =>
            (r.date === day || editingIds.has(r.id)) && (
              <div className="bp-edit-card" key={r.id ?? i}>
                <div className="bp-fields">
                  <label>
                    מוצר
                    <select
                      value={r.productId}
                      onChange={(e) =>
                        updatePack(i, { productId: e.target.value })
                      }
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
                  <PlanningDaySelect
                    week={draft.id}
                    allowWeekend={draft.allowExceptions}
                    value={r.date ?? ""}
                    onChange={(date) => updatePack(i, { date })}
                  />
                  <label>
                    מיכל
                    <select
                      value={r.tankId ?? ""}
                      onChange={(e) =>
                        updatePack(i, { tankId: e.target.value })
                      }
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
                    onChange={(e) =>
                      updatePack(i, { emptyTank: e.target.checked })
                    }
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
            ),
        )}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              packaging: [
                ...draft.packaging,
                {
                  id: newRowId(),
                  productId: settings.products[0]?.id ?? "",
                  quantity: 84,
                  date: day,
                  source: "manual",
                },
              ],
            })
          }
        >
          הוספת אריזה
        </button>
        <h4>בישולים</h4>
        {draft.brews.map(
          (b, i) =>
            (b.date === day || editingIds.has(b.id)) && (
              <div className="bp-edit-card" key={b.id}>
                <div className="bp-fields">
                  <label>
                    סגנון
                    <select
                      value={b.style}
                      onChange={(e) => updateBrew(i, { style: e.target.value })}
                    >
                      {[
                        ...new Set(
                          settings.products
                            .filter((p) => !p.id.startsWith("special:"))
                            .map((p) => p.style),
                        ),
                      ].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
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
                  <PlanningDaySelect
                    week={draft.id}
                    allowWeekend={draft.allowExceptions}
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
            ),
        )}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              brews: [
                ...draft.brews,
                {
                  id: newRowId(),
                  tankId: "",
                  style: settings.products[0]?.style ?? "",
                  date: day,
                  liters: 0,
                },
              ],
            })
          }
        >
          הוספת בישול
        </button>
        <h4>תכולת משלוחים שנקבעה</h4>
        {(draft.deliveries ?? []).map(
          (d, i) =>
            (d.dispatchDate === day || editingIds.has(d.id)) && (
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
                  <PlanningDaySelect
                    week={draft.id}
                    allowWeekend={draft.allowExceptions}
                    value={d.dispatchDate}
                    label="יום איסוף וקליטה"
                    onChange={(dispatchDate) =>
                      updateDelivery(i, {
                        dispatchDate,
                        arrivalDate: dispatchDate,
                      })
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
            ),
        )}
        <button
          onClick={() =>
            setDraft({
              ...draft,
              deliveries: [
                ...(draft.deliveries ?? []),
                {
                  id: newRowId(),
                  productId: settings.products[0]?.id ?? "",
                  quantity: 84,
                  dispatchDate: day,
                  arrivalDate: day,
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
          <button onClick={save}>
            {busy ? "שומר…" : "שמירת השינויים ביום"}
          </button>
          <button onClick={onCancel}>סגירה ללא שמירת השינויים</button>
        </div>
      </fieldset>
    </section>
  );
}
