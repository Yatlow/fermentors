import { useMemo, useState } from "react";
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
    copy.packaging = copy.packaging.map((r) => ({
      ...r,
      id: r.id ?? crypto.randomUUID(),
    }));
    return copy;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [palletToAdd, setPalletToAdd] = useState("");

  const dayPacks = draft.packaging
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.date === day);
  const visibleBrews = draft.brews.map((b, i) => ({ b, i }));
  const dayDeliveries = (draft.deliveries ?? [])
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.dispatchDate === day);
  const styles = useMemo(
    () => [
      ...new Set(
        settings.products
          .filter((p) => !p.id.startsWith("special:"))
          .map((p) => p.style),
      ),
    ],
    [settings],
  );

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
    setDraft((w) => ({
      ...w,
      packaging: w.packaging.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  const updateBrew = (i: number, patch: Partial<BrewPlan>) =>
    setDraft((w) => ({
      ...w,
      brews: w.brews.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));

  const reservedPallets = new Set(
    (draft.deliveries ?? []).flatMap((d) => d.pallets ?? []).map((p) => p.id),
  );
  const availablePallets = pallets
    .filter((p) => p.zone !== "shipped" && !reservedPallets.has(p.id))
    .sort((a, b) => {
      const aFull = a.itemType === "crates" && num(a.quantity) >= 60 ? 1 : 0;
      const bFull = b.itemType === "crates" && num(b.quantity) >= 60 ? 1 : 0;
      return bFull - aFull || a.beerStyle.localeCompare(b.beerStyle);
    });

  function addPallet() {
    const pallet = availablePallets.find((p) => p.id === palletToAdd);
    if (!pallet) return;
    const product = settings.products.find(
      (p) => p.type === pallet.itemType && sameStyle(p.style, pallet.beerStyle),
    );
    if (!product) {
      setError(`לא נמצא מוצר תכנון מתאים למשטח ${pallet.beerStyle}`);
      return;
    }
    const qty = Math.round(num(pallet.quantity));
    setDraft((w) => {
      const deliveries = [...(w.deliveries ?? [])];
      const existingIndex = deliveries.findIndex(
        (d) => d.dispatchDate === day && d.productId === product.id,
      );
      if (existingIndex >= 0) {
        const current = deliveries[existingIndex];
        deliveries[existingIndex] = {
          ...current,
          quantity: current.quantity + qty,
          pallets: [...(current.pallets ?? []), pallet],
        };
      } else {
        const next: DeliveryPlan = {
          id: crypto.randomUUID(),
          productId: product.id,
          quantity: qty,
          dispatchDate: day,
          arrivalDate: day,
          truckId: `truck:${day}`,
          pallets: [pallet],
        };
        deliveries.push(next);
      }
      return {
        ...w,
        deliveries,
        deliveryDates: [...new Set([...(w.deliveryDates ?? []), day])].sort(),
      };
    });
    setPalletToAdd("");
  }

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
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  function addPackaging() {
    const tank = tanks.find(
      (t) => t.ready <= day && t.liters - usedLiters(t.id) >= 1,
    );
    const product =
      tank &&
      settings.products.find(
        (p) => !p.id.startsWith("special:") && sameStyle(p.style, tank.style),
      );
    const id = crypto.randomUUID();
    const quantity =
      tank && product ? maxTankQuantity(tank.id, product.id, id) : 0;
    setDraft((w) => ({
      ...w,
      packaging: [
        ...w.packaging,
        {
          id,
          productId: product?.id ?? settings.products[0]?.id ?? "",
          tankId: tank?.id ?? "",
          quantity,
          date: day,
          source: "manual",
        },
      ],
    }));
  }

  function addBrew() {
    if (!defaultBrewDate) {
      setError("אין עוד יום בישול זמין בשבוע הזה");
      return;
    }
    setDraft((w) => ({
      ...w,
      brews: [
        ...w.brews,
        {
          id: crypto.randomUUID(),
          tankId: "",
          style: styles[0] ?? "",
          date: defaultBrewDate,
          liters: 0,
        },
      ],
    }));
  }

  return (
    <section className="bp-editor" aria-label={scope === "brews" ? "עריכת בישולים" : "עריכת היום"}>
      <div className="bp-editor-header">
        <div>
          <h3>
            {scope === "brews"
              ? `בישולים · שבוע ${weekNumber(draft.id)}`
              : `עריכת ${shortDate(day)}`}
          </h3>
          <small>
            {scope === "brews"
              ? "הבישול שייך לשבוע. יום העבודה הפנימי נקבע אוטומטית לצורך התחזית."
              : "שינוי יום פעולה מעביר אותה ליום אחר בלוח."}
          </small>
        </div>
        <button type="button" onClick={onCancel}>סגירה</button>
      </div>

      <fieldset disabled={disabled || busy} className="bp-fieldset bp-editor-body">
        {scope === "day" && (
          <>
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
            {dayPacks.map(({ r, i }) => {
              const tank = tanks.find((t) => t.id === r.tankId);
              const products = settings.products.filter(
                (p) =>
                  !p.id.startsWith("special:") &&
                  (!tank || sameStyle(p.style, tank.style)),
              );
              const max = r.tankId
                ? maxTankQuantity(r.tankId, r.productId, r.id)
                : 0;
              return (
                <div className="bp-edit-card" key={r.id}>
                  <div className="bp-fields">
                    <label>
                      מיכל
                      <select
                        value={r.tankId ?? ""}
                        onChange={(e) => {
                          const nextTank = tanks.find((t) => t.id === e.target.value);
                          const nextProduct = settings.products.find(
                            (p) =>
                              nextTank &&
                              sameStyle(p.style, nextTank.style) &&
                              !p.id.startsWith("special:"),
                          );
                          updatePack(i, {
                            tankId: e.target.value,
                            productId: nextProduct?.id ?? r.productId,
                            quantity: nextProduct
                              ? maxTankQuantity(e.target.value, nextProduct.id, r.id)
                              : 0,
                          });
                        }}
                      >
                        <option value="">בחירת מיכל</option>
                        {tanks
                          .filter((t) => t.ready <= day)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.number} · {t.style} · {Math.floor(Math.max(0, t.liters - usedLiters(t.id, r.id)))} ל׳
                            </option>
                          ))}
                      </select>
                    </label>

                    <label>
                      מה אורזים
                      <select
                        value={r.productId}
                        onChange={(e) =>
                          updatePack(i, {
                            productId: e.target.value,
                            quantity: maxTankQuantity(
                              r.tankId ?? "",
                              e.target.value,
                              r.id,
                            ),
                          })
                        }
                      >
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.type === "crates" ? "בקבוקים" : "חביות"} · {p.style}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      כמות
                      <input
                        type="number"
                        min="1"
                        max={max || undefined}
                        value={r.quantity}
                        onChange={(e) =>
                          updatePack(i, {
                            quantity: Math.min(
                              Number(e.target.value),
                              max || Number(e.target.value),
                            ),
                          })
                        }
                      />
                      {max > 0 && (
                        <small>
                          עד {max} {settings.products.find((p) => p.id === r.productId)?.type === "crates" ? "ארגזים" : "חביות"} לפי היתרה במיכל. 252 הוא יעד עבודה רגיל בלבד, לא מגבלה.
                        </small>
                      )}
                    </label>

                    <PlanningDaySelect
                      week={draft.id}
                      allowWeekend={draft.allowExceptions}
                      value={r.date ?? day}
                      label="העברת האריזה ליום אחר"
                      onChange={(date) => updatePack(i, { date })}
                    />
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={r.emptyTank ?? false}
                      onChange={(e) => updatePack(i, { emptyTank: e.target.checked })}
                    />
                    זו האריזה האחרונה מהמיכל
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((w) => ({
                        ...w,
                        packaging: w.packaging.filter((_, j) => i !== j),
                      }))
                    }
                  >
                    הסרת האריזה
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={addPackaging}>הוספת אריזה</button>

            <h4>משלוח</h4>
            {dayDeliveries.length ? (
              <div className="bp-edit-card">
                <b>
                  משלוח אחד · {dayDeliveries.reduce((s, x) => s + (x.d.pallets?.length ?? 0), 0)} משטחים
                </b>
                {dayDeliveries.map(({ d, i }) => (
                  <div className="bp-shipment-row" key={d.id}>
                    <span>
                      {settings.products.find((p) => p.id === d.productId)?.style ?? d.productId} · {d.quantity} {settings.products.find((p) => p.id === d.productId)?.type === "crates" ? "ארגזים" : "חביות"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((w) => ({
                          ...w,
                          deliveries: (w.deliveries ?? []).filter((_, j) => i !== j),
                        }))
                      }
                    >
                      הסר
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="bp-muted">לא נקבעה תכולת משלוח ליום זה.</p>
            )}

            <div className="bp-add-pallet">
              <label>
                הוספת משטח מהמקרר
                <select value={palletToAdd} onChange={(e) => setPalletToAdd(e.target.value)}>
                  <option value="">בחירת משטח</option>
                  {availablePallets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.beerStyle} · {Math.round(num(p.quantity))} {p.itemType === "crates" ? "ארגזים" : "חביות"} · משטח {p.palletNumber ?? p.id.slice(0, 6)}{p.itemType === "crates" && num(p.quantity) >= 60 ? " · מלא" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={!palletToAdd} onClick={addPallet}>
                הוסף למשלוח
              </button>
            </div>
          </>
        )}

        {scope === "brews" && (
          <>
            <h4>בישולים השבוע</h4>
            {visibleBrews.map(({ b, i }) => {
              const source = brews.find((t) => t.id === b.tankId);
              const capacity = num(source?.beerVolume);
              return (
                <div className="bp-edit-card" key={b.id}>
                  <div className="bp-fields">
                    <label>
                      סגנון
                      <select
                        value={b.style}
                        onChange={(e) => updateBrew(i, { style: e.target.value })}
                      >
                        {styles.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </label>
                    <label>
                      מיכל
                      <select
                        value={b.tankId}
                        onChange={(e) => {
                          const sourceTank = brews.find((t) => t.id === e.target.value);
                          const volume = num(sourceTank?.beerVolume);
                          updateBrew(i, {
                            tankId: e.target.value,
                            liters: volume || b.liters,
                          });
                        }}
                      >
                        <option value="">בחירת מיכל</option>
                        {brews
                          .filter((t) => Number(t.tankNumber) !== 1)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.tankNumber ?? t.id}{Number(t.action) === 0 ? " · מחכה לבישול" : ""}{num(t.beerVolume) ? ` · ${Math.round(num(t.beerVolume))} ל׳` : " · נפח חסר"}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      נפח בישול
                      <input
                        type="number"
                        min="1"
                        value={b.liters || ""}
                        readOnly={capacity > 0}
                        onChange={(e) => updateBrew(i, { liters: Number(e.target.value) })}
                      />
                      <small>
                        {capacity > 0
                          ? `מחושב אוטומטית מנפח העבודה של מיכל ${source?.tankNumber ?? ""}`
                          : "למיכל אין beerVolume בדאשבורד — אפשר להזין ידנית או לתקן את נתוני המיכל."}
                      </small>
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((w) => ({
                        ...w,
                        brews: w.brews.filter((_, j) => i !== j),
                      }))
                    }
                  >
                    הסרת הבישול
                  </button>
                </div>
              );
            })}
            <button type="button" disabled={!defaultBrewDate} onClick={addBrew}>
              הוספת בישול לשבוע
            </button>
          </>
        )}

        <div className="bp-settings">
          <label>
            <input
              type="checkbox"
              checked={draft.allowExceptions ?? false}
              onChange={(e) =>
                setDraft({ ...draft, allowExceptions: e.target.checked })
              }
            />
            חריגה משגרת ימי העבודה
          </label>
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
        {error && <p role="alert" className="bp-alert">{error}</p>}
      </fieldset>

      <div className="bp-editor-footer">
        <button type="button" disabled={disabled || busy} onClick={save}>
          {busy ? "שומר…" : "שמירת השינויים"}
        </button>
        <button type="button" onClick={onCancel}>ביטול</button>
      </div>
    </section>
  );
}
