import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import {
  addDays,
  emptyWeek,
  litersPerUnit,
  weekNumber,
  weekStart,
  type Settings,
  type Tank,
  type WeekPlan,
} from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
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
  today: string;
  workspace: Workspace;
  disabled: boolean;
  saveWeek: (week: WeekPlan) => Promise<void>;
  onOpenSchedule: () => void;
}) {
  const [week, setWeek] = useState(weekStart(today));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current =
    plans.find((w) => w.id === week) ?? {
      ...emptyWeek(week),
      maxRuns: settings.preferredRuns,
    };
  const actions = useMemo(
    () => workspace.actions.filter((a) => weekStart(a.date) === week),
    [workspace.actions, week],
  );
  const warnings = useMemo(() => {
    const unresolved = workspace.needs.filter((n) => weekStart(n.date) === week);
    const result = unresolved.map(
      (n) =>
        `${displayStyle(n.style)}: יש צורך צפוי ב${n.kind === "brew" ? "בישול" : "אריזה"}, אבל כרגע אין שיבוץ ישים. ${n.problem}`,
    );
    const engine = workspace.forecast.warnings.filter((w) =>
      [week, ...Array.from({ length: 7 }, (_, i) => shortDate(addDays(week, i)))].some(
        (token) => w.includes(token),
      ),
    );
    return [...new Set([...result, ...engine])].slice(0, 6);
  }, [workspace.needs, workspace.forecast.warnings, week]);

  const product = (id: string) => settings.products.find((p) => p.id === id);
  const sourceNumber = (id: string) =>
    sources.find((s) => s.id === id)?.tankNumber ??
    tanks.find((t) => t.id === id)?.number ??
    id;

  const ship = actions.filter((a) => a.kind === "delivery");
  const pack = actions.filter((a) => a.kind === "packaging");
  const brew = actions.filter((a) => a.kind === "brew");

  const shippingLines = useMemo(() => {
    const groups = new Map<string, { label: string; pallets: number; quantity: number; unit: string }>();
    for (const action of ship) {
      if (action.kind !== "delivery") continue;
      const p = product(action.productId);
      if (!p) continue;
      const key = groupKey(p.style) + ":" + p.type;
      const old = groups.get(key) ?? {
        label: displayStyle(p.style),
        pallets: 0,
        quantity: 0,
        unit: p.type === "crates" ? "ארגזים" : "חביות",
      };
      old.pallets += action.pallets?.length ?? Math.ceil(action.slots ?? 0);
      old.quantity += action.quantity;
      groups.set(key, old);
    }
    return [...groups.values()];
  }, [ship, settings.products]);

  const packagingLines = useMemo(() => {
    return pack.flatMap((action) => {
      if (action.kind !== "packaging") return [];
      const p = product(action.productId);
      const allocations = action.allocations;
      if (!p) return [];
      if (!allocations.length)
        return [{
          key: action.id,
          text: `${displayStyle(p.style)} · ${fmt(action.quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"}`,
          sub: "לא נמצא כרגע מיכל ישים — זו אזהרה ולא המלצה לביצוע",
          warning: true,
        }];
      return [{
        key: action.id,
        text: `${displayStyle(p.style)} · ${fmt(action.quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"} · מיכל ${allocations.map((a) => a.number).join(", ")}`,
        sub: allocations.map((a) => {
          const tank = tanks.find((t) => t.id === a.tankId);
          const sameWeekLiters = pack
            .filter((x) => x.kind === "packaging")
            .flatMap((x) => x.kind === "packaging" ? x.allocations : [])
            .filter((x) => x.tankId === a.tankId)
            .reduce((sum, x) => sum + x.liters, 0);
          const remainder = tank ? Math.max(0, tank.liters - sameWeekLiters) : null;
          const nextWeek = workspace.actions.some(
            (x) =>
              x.kind === "packaging" &&
              weekStart(x.date) === addDays(week, 7) &&
              x.allocations.some((allocation) => allocation.tankId === a.tankId),
          );
          if (remainder !== null && remainder < 20) return `מיכל ${a.number}: מומלץ לרוקן השבוע`;
          if (nextWeek) return `מיכל ${a.number}: ההמלצה מפצלת את הריקון לשבוע הבא`;
          if (remainder !== null) return `מיכל ${a.number}: צפויה יתרה של כ־${fmt(remainder)} ל׳ לאחר השבוע`;
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
      text: `${displayStyle(action.style)} · מיכל ${sourceNumber(action.tankId)} · ${fmt(action.liters)} ל׳`,
      sub: action.dependent
        ? "זמין לאחר ריקון מתוכנן"
        : "המיכל פנוי / מחכה לבישול",
    }];
  });

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

  const savedDeliveryPallets = (current.deliveries ?? []).reduce(
    (sum, d) => sum + (d.pallets?.length ?? 0),
    0,
  );

  return (
    <section className="bp-weekly-planner">
      <div className="bp-section-heading">
        <div>
          <h2>המלצות שבועיות</h2>
          <p className="bp-muted">המתכנן מחליט מה צריך לקרות השבוע. השיבוץ ליום מסוים נעשה אחר כך בלוח העבודה היומי.</p>
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
          <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{shippingLines.reduce((s, x) => s + x.pallets, 0)} משטחים</b></header>
          {(current.deliveries ?? []).length > 0 && <p className="bp-saved-summary">נקבע כבר: {savedDeliveryPallets} משטחים · {(current.deliveries ?? []).length} סעיפים</p>}
          {shippingLines.length ? shippingLines.map((line) => (
            <div className="bp-rec-line" key={`${line.label}:${line.unit}`}>
              <b>{line.label}</b><span>{line.pallets} משטחים · {fmt(line.quantity)} {line.unit}</span>
            </div>
          )) : <p className="bp-muted">אין צורך במשלוח נוסף לפי התחזית לשבוע הזה.</p>}
          <div className="bp-actions"><button disabled={disabled || busy || !ship.length} onClick={() => accept("delivery")}>קבל כהחלטה שבועית</button><button onClick={onOpenSchedule}>עריכה / שיבוץ</button></div>
        </article>

        <article className="bp-week-rec-card">
          <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{pack.length} פעולות</b></header>
          {current.packaging.length > 0 && <p className="bp-saved-summary">נקבעו כבר {current.packaging.length} אריזות בשבוע.</p>}
          {packagingLines.length ? packagingLines.map((line) => (
            <div className={`bp-rec-line ${line.warning ? "is-warning" : ""}`} key={line.key}><b>{line.text}</b><span>{line.sub}</span></div>
          )) : <p className="bp-muted">אין המלצת אריזה נוספת לשבוע הזה.</p>}
          <p className="bp-rec-principle">מטרת ברירת המחדל: לרוקן מיכל באותו שבוע. פיצול לשבוע נוסף מוצג במפורש.</p>
          <div className="bp-actions"><button disabled={disabled || busy || !pack.length} onClick={() => accept("packaging")}>קבל כהחלטה שבועית</button><button onClick={onOpenSchedule}>עריכה / שיבוץ</button></div>
        </article>

        <article className="bp-week-rec-card">
          <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{brew.length} בישולים</b></header>
          {current.brews.length > 0 && <p className="bp-saved-summary">נקבעו כבר {current.brews.length} בישולים בשבוע.</p>}
          {brewingLines.length ? brewingLines.map((line) => (
            <div className="bp-rec-line" key={line.key}><b>{line.text}</b><span>{line.sub}</span></div>
          )) : <p className="bp-muted">אין כרגע בישול נוסף שנדרש לפי התחזית. מיכל שמחכה לבישול מקבל נפח משוער אוטומטי לפי גודלו כדי שיוכל להשתתף בהמלצה.</p>}
          <div className="bp-actions"><button disabled={disabled || busy || !brew.length} onClick={() => accept("brew")}>קבל כהחלטה שבועית</button><button onClick={onOpenSchedule}>עריכה / שיבוץ</button></div>
        </article>
      </div>

      {message && <p role="status">{message}</p>}
    </section>
  );
}
