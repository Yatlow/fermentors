import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import {
  addDays,
  emptyWeek,
  sameStyle,
  weekNumber,
  weekStart,
  type DeliveryPlan,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import {
  displayStyle,
  groupKey,
} from "../../SERVICES/planning/planningPresentation";
import {
  adoptAction,
  type PlanningAction,
  type planningWorkspace,
} from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
type Kind = PlanningAction["kind"];

const fmt = (n: number) =>
  Math.round(n).toLocaleString("he-IL", { maximumFractionDigits: 0 });

export default function PlanningWeeklyRecommendations({
  settings,
  plans,
  tanks,
  sources,
  pallets,
  today,
  workspace,
  disabled,
  saveWeek,
  onOpenSchedule,
}: {
  settings: Settings;
  plans: WeekPlan[];
  tanks: Tank[];
  sources: Fermentor[];
  pallets: Pallet[];
  today: string;
  workspace: Workspace;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
  onOpenSchedule: () => void;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Kind | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});
  const [extraShipProduct, setExtraShipProduct] = useState("");
  const [extraShipQty, setExtraShipQty] = useState(0);

  const current = plans.find((w) => w.id === week) ?? {
    ...emptyWeek(week),
    maxRuns: settings.preferredRuns,
  };
  const actions = useMemo(
    () => workspace.actions.filter((a) => weekStart(a.date) === week),
    [workspace.actions, week],
  );
  const product = (id: string) => settings.products.find((p) => p.id === id);
  const sourceNumber = (id: string) =>
    sources.find((s) => s.id === id)?.tankNumber ??
    tanks.find((t) => t.id === id)?.number ??
    id;

  const ship = actions.filter((a) => a.kind === "delivery");
  const pack = actions.filter((a) => a.kind === "packaging");
  const brew = actions.filter((a) => a.kind === "brew");

  const warnings = useMemo(() => {
    const unresolved = workspace.needs.filter(
      (n) =>
        weekStart(n.date) === week &&
        (n.problem.includes("אין ") ||
          n.problem.includes("כבר מוקצה") ||
          n.problem.includes("מכסה רק חלק")),
    );
    const result = unresolved.map((n) => {
      const scheduled =
        n.kind === "packaging"
          ? current.packaging
              .filter((p) => p.productId === n.productId)
              .reduce((sum, p) => sum + p.quantity, 0)
          : current.brews
              .filter((b) => sameStyle(b.style, n.style))
              .reduce((sum, b) => sum + b.liters, 0);
      const unit = n.kind === "brew" ? "ל׳" : n.unit;
      return `${displayStyle(n.style)}: נקבע השבוע ${fmt(scheduled)} ${unit}; התחזית עדיין מזהה צורך נוסף של ${fmt(n.quantity)} ${n.unit}. ${n.problem}`;
    });
    const engine = workspace.forecast.warnings.filter((w) =>
      [week, ...Array.from({ length: 7 }, (_, i) => shortDate(addDays(week, i)))].some(
        (token) => w.includes(token),
      ),
    );
    return [...new Set([...result, ...engine])].slice(0, 6);
  }, [workspace.needs, workspace.forecast.warnings, week, current.packaging, current.brews]);

  const shippingLines = useMemo(() => {
    const groups = new Map<
      string,
      {
        productId: string;
        label: string;
        pallets: number;
        quantity: number;
        unit: string;
        existingPallets: number;
        plannedPallets: number;
        existingQuantity: number;
        plannedQuantity: number;
      }
    >();
    for (const action of ship) {
      if (action.kind !== "delivery") continue;
      const p = product(action.productId);
      if (!p) continue;
      const key = groupKey(p.style) + ":" + p.type;
      const old = groups.get(key) ?? {
        productId: p.id,
        label: displayStyle(p.style),
        pallets: 0,
        quantity: 0,
        unit: p.type === "crates" ? "ארגזים" : "חביות",
        existingPallets: 0,
        plannedPallets: 0,
        existingQuantity: 0,
        plannedQuantity: 0,
      };
      const selected = action.pallets ?? [];
      const existing = selected.filter((x) => !x.id.startsWith("planning:"));
      const planned = selected.filter((x) => x.id.startsWith("planning:"));
      old.pallets += selected.length || Math.ceil(action.slots ?? 0);
      old.quantity += action.quantity;
      old.existingPallets += existing.length;
      old.plannedPallets += planned.length;
      old.existingQuantity += existing.reduce((s, x) => s + x.quantity, 0);
      old.plannedQuantity += planned.reduce((s, x) => s + x.quantity, 0);
      groups.set(key, old);
    }
    return [...groups.values()];
  }, [ship, settings.products]);

  const recommendedTruckSlots = useMemo(() => {
    const trucks = new Map<string, number>();
    for (const action of ship) {
      if (action.kind !== "delivery") continue;
      trucks.set(action.truckId ?? action.date, Math.max(trucks.get(action.truckId ?? action.date) ?? 0, action.slots ?? 0));
    }
    return [...trucks.values()].reduce((sum, slots) => sum + slots, 0);
  }, [ship]);

  const packagingLines = useMemo(() => {
    return pack.flatMap((action) => {
      if (action.kind !== "packaging") return [];
      const p = product(action.productId);
      const allocations = action.allocations;
      if (!p) return [];
      if (!allocations.length)
        return [{
          key: action.id,
          action,
          text: `${displayStyle(p.style)} · ${fmt(action.quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"}`,
          sub: "לא נמצא כרגע מיכל ישים — זו אזהרה ולא המלצה לביצוע",
          warning: true,
        }];
      return [{
        key: action.id,
        action,
        text: `${displayStyle(p.style)} · ${fmt(action.quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"} · מיכל ${allocations.map((a) => a.number).join(", ")}`,
        sub: allocations.map((a) => {
          const tank = tanks.find((t) => t.id === a.tankId);
          const sameWeekLiters = pack
            .filter((x) => x.kind === "packaging")
            .flatMap((x) => (x.kind === "packaging" ? x.allocations : []))
            .filter((x) => x.tankId === a.tankId)
            .reduce((sum, x) => sum + x.liters, 0);
          const remainder = tank ? Math.max(0, tank.liters - sameWeekLiters) : null;
          const nextWeek = workspace.actions.some(
            (x) =>
              x.kind === "packaging" &&
              weekStart(x.date) === addDays(week, 7) &&
              x.allocations.some((allocation) => allocation.tankId === a.tankId),
          );
          if (remainder !== null && remainder < 20)
            return `מיכל ${a.number}: מומלץ לרוקן השבוע`;
          if (nextWeek)
            return `מיכל ${a.number}: ההמלצה מפצלת את הריקון לשבוע הבא`;
          if (remainder !== null)
            return `מיכל ${a.number}: צפויה יתרה של כ־${fmt(remainder)} ל׳ לאחר השבוע`;
          return `מיכל ${a.number}`;
        }).join(" · "),
        warning: false,
      }];
    });
  }, [pack, tanks, workspace.actions, week, settings.products]);

  const brewingLines = brew.flatMap((action) => {
    if (action.kind !== "brew") return [];
    return [{
      key: action.id,
      action,
      text: `${displayStyle(action.style)} · מיכל ${sourceNumber(action.tankId)} · ${fmt(action.liters)} ל׳`,
      sub: action.dependent
        ? "זמין לאחר ריקון מתוכנן"
        : "המיכל פנוי / מחכה לבישול — עדיף לנצל אותו עכשיו לצורך העתידי הקרוב ביותר",
    }];
  });

  function startEdit(kind: Kind) {
    setEditing(kind);
    const values: Record<string, number> = {};
    for (const action of actions.filter((a) => a.kind === kind))
      values[action.id] = action.kind === "brew" ? action.liters : action.quantity;
    setDraftQty(values);
    setMessage("");
  }

  async function saveEdited(kind: Kind) {
    const selected = actions.filter((a) => a.kind === kind);
    setBusy(true);
    setMessage("");
    try {
      let next = structuredClone(current);
      for (const action of selected) {
        const value = Math.max(0, Number(draftQty[action.id] ?? 0));
        if (!value) continue;
        if (action.kind === "brew") {
          if (next.brews.some((x) => x.id === action.id)) continue;
          next = adoptAction(next, { ...action, liters: Math.min(value, action.liters) });
        } else if (action.kind === "packaging") {
          if (next.packaging.some((x) => x.id === action.id)) continue;
          next = adoptAction(next, { ...action, quantity: Math.min(value, action.quantity) });
        } else {
          if ((next.deliveries ?? []).some((x) => x.id === action.id)) continue;
          next = adoptAction(next, { ...action, quantity: value, pallets: [] });
        }
      }
      if (kind === "delivery" && extraShipProduct && extraShipQty > 0) {
        const p = product(extraShipProduct);
        if (p) {
          const date = ship.find((a) => a.kind === "delivery")?.date ?? addDays(week, 1);
          const extra: DeliveryPlan = {
            id: crypto.randomUUID(),
            productId: p.id,
            quantity: extraShipQty,
            dispatchDate: date,
            arrivalDate: date,
            truckId: `truck:${date}`,
            pallets: [],
          };
          next.deliveries ??= [];
          next.deliveries.push(extra);
        }
      }
      next.changeReason = `עריכת המלצת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next);
      setEditing(null);
      setExtraShipProduct("");
      setExtraShipQty(0);
      setMessage("ההמלצה נערכה ונשמרה כהחלטה שבועית. השיבוץ לימים נשאר משימה נפרדת.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  async function accept(kind: Kind) {
    const selected = actions.filter((a) => a.kind === kind);
    if (!selected.length) return;
    setBusy(true);
    setMessage("");
    try {
      let next = structuredClone(current);
      for (const action of selected) {
        const already =
          action.kind === "brew"
            ? next.brews.some((x) => x.id === action.id)
            : action.kind === "packaging"
              ? next.packaging.some((x) => x.id === action.id)
              : (next.deliveries ?? []).some((x) => x.id === action.id);
        if (!already) next = adoptAction(next, action);
      }
      next.changeReason = `אישור המלצת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next);
      setMessage("ההמלצה נשמרה כהחלטה שבועית. מנהל העבודה יכול לשבץ אותה לימים.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  const savedDeliveryPallets = (current.deliveries ?? []).reduce((sum, d) => {
    const p = product(d.productId);
    if (!p) return sum;
    return sum + (d.pallets?.length || projectedPallets(p, d.quantity, d.id).length);
  }, 0);

  const savedTruckSlots = useMemo(() => {
    try {
      const manifest = (current.deliveries ?? []).flatMap((d) => {
        const p = product(d.productId);
        if (!p) return [];
        return d.pallets?.length
          ? d.pallets
          : projectedPallets(p, d.quantity, d.id).map((x) => x.pallet);
      });
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch {
      return 0;
    }
  }, [current.deliveries, settings.products]);

  const availableFor = (productId: string) => {
    const p = product(productId);
    if (!p) return { pallets: 0, quantity: 0, plannedPallets: 0, plannedQuantity: 0 };
    const physical = pallets.filter(
      (x) =>
        x.zone !== "shipped" &&
        x.itemType === p.type &&
        sameStyle(x.beerStyle, p.style),
    );
    const plannedQuantity = current.packaging
      .filter((x) => x.productId === p.id)
      .reduce((sum, x) => sum + x.quantity, 0);
    return {
      pallets: physical.length,
      quantity: physical.reduce((sum, x) => sum + x.quantity, 0),
      plannedPallets: plannedQuantity > 0 ? projectedPallets(p, plannedQuantity, `week:${week}`).length : 0,
      plannedQuantity,
    };
  };

  return (
    <section className="bp-weekly-planner">
      <div className="bp-section-heading">
        <div>
          <h2>המלצות שבועיות</h2>
          <p className="bp-muted">
            כאן עורכים את ההחלטה השבועית עצמה. רק אחרי האישור עוברים ללוח העבודה כדי לשבץ לימים.
          </p>
        </div>
      </div>

      <div className="bp-week-picker">
        {Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => (
          <button key={w} aria-pressed={week === w} onClick={() => setWeek(w)}>
            שבוע {weekNumber(w)}<small>{shortDate(w)}</small>
          </button>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="bp-week-alerts">
          <b>אזהרות לתוכנית</b>
          {warnings.map((warning) => <span key={warning}>⚠ {warning}</span>)}
        </div>
      )}

      <div className="bp-week-recommendations">
        <article className="bp-week-rec-card">
          <header>
            <div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div>
            <b>{recommendedTruckSlots}/{MAX_TRUCK_SLOTS} מקומות</b>
          </header>
          {(current.deliveries ?? []).length > 0 && (
            <p className="bp-saved-summary">
              נקבע כבר: {savedDeliveryPallets} משטחים · {savedTruckSlots}/{MAX_TRUCK_SLOTS} מקומות במשאית
            </p>
          )}
          {shippingLines.length ? shippingLines.map((line) => {
            const availability = availableFor(line.productId);
            return (
              <div className="bp-rec-line" key={`${line.label}:${line.unit}`}>
                <b>{line.label}</b>
                <span>{line.pallets} משטחים · {fmt(line.quantity)} {line.unit}</span>
                <span>מתוך ההמלצה: {line.existingPallets} משטחים / {fmt(line.existingQuantity)} כבר במלאי · {line.plannedPallets} משטחים / {fmt(line.plannedQuantity)} יגיעו מתכנון</span>
                <span>זמין כרגע להוספה: {availability.pallets} משטחים ({fmt(availability.quantity)} {line.unit}) · מתכנון השבוע: {availability.plannedPallets} משטחים ({fmt(availability.plannedQuantity)} {line.unit})</span>
              </div>
            );
          }) : <p className="bp-muted">אין צורך במשלוח נוסף לפי התחזית לשבוע הזה.</p>}

          {editing === "delivery" && (
            <div className="bp-week-edit">
              {ship.map((action) => action.kind === "delivery" && (
                <label key={action.id}>
                  {product(action.productId) ? `${displayStyle(product(action.productId)!.style)} · ${product(action.productId)!.type === "crates" ? "ארגזים" : "חביות"}` : action.productId}
                  <input type="number" min="0" value={draftQty[action.id] ?? action.quantity} onChange={(e) => setDraftQty((q) => ({ ...q, [action.id]: Number(e.target.value) }))} />
                </label>
              ))}
              <div className="bp-fields">
                <label>
                  הוספת מוצר למשלוח
                  <select value={extraShipProduct} onChange={(e) => setExtraShipProduct(e.target.value)}>
                    <option value="">בחירת מוצר</option>
                    {settings.products.filter((p) => p.monthly > 0).map((p) => (
                      <option key={p.id} value={p.id}>{displayStyle(p.style)} · {p.type === "crates" ? "ארגזים" : "חביות"}</option>
                    ))}
                  </select>
                </label>
                <label>
                  כמות להוסיף
                  <input type="number" min="0" value={extraShipQty || ""} onChange={(e) => setExtraShipQty(Number(e.target.value))} />
                </label>
              </div>
              {extraShipProduct && (() => {
                const a = availableFor(extraShipProduct);
                const p = product(extraShipProduct)!;
                return <small>זמין פיזית: {a.pallets} משטחים / {fmt(a.quantity)} {p.type === "crates" ? "ארגזים" : "חביות"} · מתכנון: {a.plannedPallets} משטחים / {fmt(a.plannedQuantity)}</small>;
              })()}
              <div className="bp-actions"><button disabled={busy} onClick={() => saveEdited("delivery")}>שמירת עריכת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></div>
            </div>
          )}

          {editing !== "delivery" && (
            <div className="bp-actions">
              <button disabled={disabled || busy || !ship.length} onClick={() => accept("delivery")}>קבל כהחלטה שבועית</button>
              <button disabled={disabled || busy} onClick={() => startEdit("delivery")}>עריכת ההמלצה</button>
              <button onClick={onOpenSchedule}>שיבוץ לימים</button>
            </div>
          )}
        </article>

        <article className="bp-week-rec-card">
          <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{pack.length} פעולות</b></header>
          {current.packaging.length > 0 && <p className="bp-saved-summary">נקבעו כבר {current.packaging.length} אריזות בשבוע.</p>}
          {packagingLines.length ? packagingLines.map((line) => (
            <div className={`bp-rec-line ${line.warning ? "is-warning" : ""}`} key={line.key}>
              <b>{line.text}</b><span>{line.sub}</span>
              {editing === "packaging" && <input type="number" min="0" max={line.action.quantity} value={draftQty[line.action.id] ?? line.action.quantity} onChange={(e) => setDraftQty((q) => ({ ...q, [line.action.id]: Number(e.target.value) }))} />}
            </div>
          )) : <p className="bp-muted">אין המלצת אריזה נוספת לשבוע הזה.</p>}
          <p className="bp-rec-principle">מטרת ברירת המחדל: לרוקן מיכל באותו שבוע. פיצול לשבוע נוסף מוצג במפורש.</p>
          {editing === "packaging" ? (
            <div className="bp-actions"><button disabled={busy} onClick={() => saveEdited("packaging")}>שמירת העריכה</button><button onClick={() => setEditing(null)}>ביטול</button></div>
          ) : (
            <div className="bp-actions"><button disabled={disabled || busy || !pack.length} onClick={() => accept("packaging")}>קבל כהחלטה שבועית</button><button disabled={disabled || busy || !pack.length} onClick={() => startEdit("packaging")}>עריכת ההמלצה</button><button onClick={onOpenSchedule}>שיבוץ לימים</button></div>
          )}
        </article>

        <article className="bp-week-rec-card">
          <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{brew.length} בישולים</b></header>
          {current.brews.length > 0 && <p className="bp-saved-summary">נקבעו כבר {current.brews.length} בישולים בשבוע.</p>}
          {brewingLines.length ? brewingLines.map((line) => (
            <div className="bp-rec-line" key={line.key}>
              <b>{line.text}</b><span>{line.sub}</span>
              {editing === "brew" && <input type="number" min="0" max={line.action.liters} value={draftQty[line.action.id] ?? line.action.liters} onChange={(e) => setDraftQty((q) => ({ ...q, [line.action.id]: Number(e.target.value) }))} />}
            </div>
          )) : <p className="bp-muted">אין כרגע בישול נוסף שנדרש לפי התחזית.</p>}
          {editing === "brew" ? (
            <div className="bp-actions"><button disabled={busy} onClick={() => saveEdited("brew")}>שמירת העריכה</button><button onClick={() => setEditing(null)}>ביטול</button></div>
          ) : (
            <div className="bp-actions"><button disabled={disabled || busy || !brew.length} onClick={() => accept("brew")}>קבל כהחלטה שבועית</button><button disabled={disabled || busy || !brew.length} onClick={() => startEdit("brew")}>עריכת ההמלצה</button><button onClick={onOpenSchedule}>שיבוץ לימים</button></div>
          )}
        </article>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
