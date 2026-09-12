import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import { addDays, emptyWeek, litersPerUnit, sameStyle, weeklyDemand, weekNumber, weekStart, type Actual, type DeliveryPlan, type Holiday, type Settings, type Tank, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { actualDate, shortDate } from "../../SERVICES/planning/dailyPlanner";
import { projectedPallets } from "../../SERVICES/planning/truckPlanner";
import { tankReleases, weekday } from "../../SERVICES/planning/productionCycle";
import { CORE_STYLES, displayStyle, isCoreStyle } from "../../SERVICES/planning/planningPresentation";
import { adoptAction, type PlanningAction, type planningWorkspace } from "../../SERVICES/planning/workspace";

type Workspace = ReturnType<typeof planningWorkspace>;
type DeliveryAction = PlanningAction & { kind: "delivery"; productId: string; quantity: number; pallets?: Pallet[]; slots?: number; truckId?: string };
type PackagingAction = PlanningAction & { kind: "packaging"; productId: string; quantity: number; allocations: { tankId: string; number: string; liters: number; ready: string; cold: boolean }[]; reason?: string };
type BrewAction = PlanningAction & { kind: "brew"; style: string; tankId: string; liters: number; reason: string };
type Kind = PlanningAction["kind"];
type BrewDraft = { style: string; liters: number };
const fmt = (n: number) => Math.round(n).toLocaleString("he-IL", { maximumFractionDigits: 0 });
const palletSize = (p: { type: "crates" | "kegs" }) => p.type === "crates" ? 84 : 20;
const plannerDefaultWeek = (today: string) => weekday(today) >= 5 ? addDays(weekStart(today), 7) : weekStart(today);

export default function PlanningWeeklyRecommendations({ settings, plans, tanks, sources, pallets, actuals, holidays, today, workspace, disabled, saveWeek }: {
  settings: Settings; plans: WeekPlan[]; tanks: Tank[]; sources: Fermentor[]; pallets: Pallet[]; actuals: Actual[]; holidays: Holiday[]; today: string;
  workspace: Workspace; disabled: boolean; saveWeek: (week: WeekPlan) => Promise<void>;
}) {
  const [week, setWeek] = useState(() => plannerDefaultWeek(today));
  const [editing, setEditing] = useState<Kind | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});
  const [brewDraft, setBrewDraft] = useState<Record<string, BrewDraft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const current = plans.find((w) => w.id === week) ?? { ...emptyWeek(week), maxRuns: settings.preferredRuns };
  const weekEnd = addDays(week, 6);
  const actions = useMemo(() => workspace.actions.filter((a) => weekStart(a.date) === week), [workspace.actions, week]);
  const ship = actions.filter((a) => a.kind === "delivery") as DeliveryAction[];
  const enginePack = actions.filter((a) => a.kind === "packaging") as PackagingAction[];
  const engineBrew = actions.filter((a) => a.kind === "brew") as BrewAction[];
  const product = (id: string) => settings.products.find((p) => p.id === id);
  const coreProducts = settings.products.filter((p) => p.monthly > 0 && isCoreStyle(p.style));
  const weekHolidays = holidays.filter((h) => h.date >= week && h.date <= weekEnd);

  // Coverage shown to the planner is based ONLY on saved decisions. The daily
  // recommendation scenario is intentionally excluded until it is accepted.
  const projectedPoint = (productId: string) => workspace.committedForecast.points
    .filter((p) => p.productId === productId && p.date <= weekEnd)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const projectedCover = (productId: string) => {
    const p = product(productId), point = projectedPoint(productId);
    if (!p || !point || weeklyDemand(p) <= 0 || point.tempo === null) return null;
    return (point.tempo + point.brewery) / weeklyDemand(p);
  };

  const availableReleases = useMemo(() => {
    const pool = tankReleases(sources, tanks, plans, settings, actuals, today)
      .filter((r) => !!r.date && r.date! <= weekEnd)
      .sort((a, b) => a.date!.localeCompare(b.date!));
    const priorBrews = plans.filter((w) => w.id < week).flatMap((w) => w.brews).sort((a, b) => a.date.localeCompare(b.date));
    for (const b of priorBrews) {
      let index = b.tankId ? pool.findIndex((r) => r.tankId === b.tankId && r.date! <= b.date) : -1;
      if (index < 0) index = pool.findIndex((r) => r.date! <= b.date);
      if (index >= 0) pool.splice(index, 1);
    }
    return pool;
  }, [sources, tanks, plans, settings, actuals, today, week, weekEnd]);
  const availableTankCount = availableReleases.length;

  const maxPackagingRuns = Math.min(current.maxRuns, settings.preferredRuns);
  const occupiedPackagingDays = new Set([
    ...current.packaging.filter((r) => r.quantity > 0 && r.date).map((r) => r.date!),
    ...actuals.map(actualDate).filter((d): d is string => !!d && weekStart(d) === week),
  ]);
  const undatedPackagingRuns = current.packaging.filter((r) => r.quantity > 0 && !r.date).length;
  const usedPackagingRuns = occupiedPackagingDays.size + undatedPackagingRuns;
  const remainingPackagingRuns = Math.max(0, maxPackagingRuns - usedPackagingRuns);

  const warnings = useMemo(() => workspace.needs.filter((n) => weekStart(n.date) === week).map((n) => {
    const scheduled = n.kind === "packaging"
      ? current.packaging.filter((p) => p.productId === n.productId).reduce((sum, p) => sum + p.quantity, 0)
      : current.brews.filter((b) => sameStyle(b.style, n.style)).reduce((sum, b) => sum + b.liters, 0);
    const explanation = n.problem.includes("כבר מוקצה") ? "הכמות שכבר נקבעה מהמיכל אינה מספיקה לצורך המחושב." : n.problem;
    return `${displayStyle(n.style)}: נקבע ${fmt(scheduled)} ${n.kind === "brew" ? "ל׳" : n.unit}; עדיין חסרים כ־${fmt(n.quantity)} ${n.unit}. ${explanation}`;
  }).slice(0, 6), [workspace.needs, week, current.packaging, current.brews]);

  const availableFor = (id: string) => {
    const p = product(id);
    if (!p) return { physicalPallets: 0, physicalQty: 0, plannedPallets: 0, plannedQty: 0 };
    const physical = pallets.filter((x) => x.zone !== "shipped" && x.itemType === p.type && sameStyle(x.beerStyle, p.style));
    const plannedQty = plans.filter((w) => w.id <= week).flatMap((w) => w.packaging.map((x) => ({ ...x, weekId: w.id }))).filter((x) => x.productId === p.id && (x.date ?? x.weekId) <= weekEnd).reduce((sum, x) => sum + x.quantity, 0);
    return { physicalPallets: physical.length, physicalQty: physical.reduce((sum, x) => sum + x.quantity, 0), plannedPallets: plannedQty ? projectedPallets(p, plannedQty, `week:${week}`).length : 0, plannedQty };
  };

  const slotsFor = (p: (typeof coreProducts)[number], quantity: number) => {
    try {
      const manifest = projectedPallets(p, quantity, `slots:${week}:${p.id}`).map((x) => x.pallet);
      return manifest.length ? calcTruckSlots(manifest) : 0;
    } catch { return 0; }
  };

  const shipmentRows = coreProducts.map((p) => {
    const recommendedQty = ship.filter((a) => a.productId === p.id).reduce((s, a) => s + a.quantity, 0);
    const decidedQty = (current.deliveries ?? []).filter((d) => d.productId === p.id).reduce((s, d) => s + d.quantity, 0);
    const cover = projectedCover(p.id);
    return { p, recommendedQty, decidedQty, recPallets: recommendedQty ? projectedPallets(p, recommendedQty, `rec:${week}:${p.id}`).length : 0, recSlots: slotsFor(p, recommendedQty), decidedPallets: decidedQty ? Math.ceil(decidedQty / palletSize(p)) : 0, availability: availableFor(p.id), cover, severity: cover === null ? "neutral" : cover < 1 ? "critical" : cover < settings.targetWeeks ? "warning" : "ok" };
  });

  const pack = useMemo(() => {
    if (remainingPackagingRuns <= 0) return [] as PackagingAction[];
    const target = settings.totalTargetWeeks ?? settings.targetWeeks;
    const coverOf = (id: string) => projectedCover(id) ?? Infinity;
    const result: PackagingAction[] = enginePack
      .filter((a) => coverOf(a.productId) < target)
      .sort((a, b) => coverOf(a.productId) - coverOf(b.productId))
      .slice(0, remainingPackagingRuns);
    const usedTankIds = new Set([...current.packaging.map((x) => x.tankId), ...result.flatMap((x) => x.allocations.map((a) => a.tankId))]);
    const ranked = coreProducts.map((p) => ({ p, cover: projectedCover(p.id) })).filter((x) => x.cover !== null && x.cover! < target).sort((a, b) => a.cover! - b.cover!);
    for (const { p, cover } of ranked) {
      if (result.length >= remainingPackagingRuns) break;
      if (result.some((x) => x.productId === p.id) || current.packaging.some((x) => x.productId === p.id)) continue;
      const tank = tanks.find((t) => !usedTankIds.has(t.id) && sameStyle(t.style, p.style) && t.ready <= weekEnd && weekday(t.ready < week ? week : t.ready) <= 4);
      if (!tank) continue;
      const quantity = Math.floor(tank.liters / litersPerUnit(p));
      if (quantity <= 0) continue;
      const date = tank.ready < week ? week : tank.ready;
      result.push({ id: `weekly-pack:${week}:${p.id}:${tank.id}`, kind: "packaging", status: "recommended", date, productId: p.id, quantity, allocations: [{ tankId: tank.id, number: String(tank.number), liters: tank.liters, ready: tank.ready, cold: tank.cold }], reason: `כיסוי צפוי ${cover!.toFixed(1)} שבועות; מומלץ לרוקן את מיכל ${tank.number} השבוע` } as PackagingAction);
      usedTankIds.add(tank.id);
    }
    return result;
  }, [enginePack, current.packaging, coreProducts, tanks, week, weekEnd, settings, remainingPackagingRuns, workspace.committedForecast]);

  const packagingRows = coreProducts.map((p) => {
    const rec = pack.filter((a) => a.productId === p.id), saved = current.packaging.filter((x) => x.productId === p.id), cover = projectedCover(p.id);
    return { p, rec, saved, cover, recommendedQty: rec.reduce((s, a) => s + a.quantity, 0), decidedQty: saved.reduce((s, a) => s + a.quantity, 0), tankText: [...new Set([...saved.map((x) => tanks.find((t) => t.id === x.tankId)?.number ?? x.tankNumber), ...rec.flatMap((x) => x.allocations.map((a) => a.number))].filter(Boolean))].join(", "), severity: cover === null ? "neutral" : cover < 1 ? "critical" : cover < (settings.totalTargetWeeks ?? settings.targetWeeks) ? "warning" : "ok" };
  }).sort((a, b) => (a.cover ?? Infinity) - (b.cover ?? Infinity));

  const brew = useMemo(() => {
    const result: BrewAction[] = [...engineBrew];
    const remainingSlots = Math.max(0, availableTankCount - current.brews.length);
    if (result.length >= remainingSlots) return result.slice(0, remainingSlots);
    const usedStyles = new Set([...current.brews.map((b) => displayStyle(b.style)), ...result.map((b) => displayStyle(b.style))]);
    const styleRows = CORE_STYLES.map((style) => {
      const ps = coreProducts.filter((p) => sameStyle(p.style, style));
      const covers = ps.map((p) => projectedCover(p.id)).filter((v): v is number => v !== null);
      return { style, cover: covers.length ? Math.min(...covers) : Infinity };
    }).sort((a, b) => a.cover - b.cover);
    let releaseIndex = 0;
    for (const row of styleRows) {
      if (result.length >= remainingSlots) break;
      if (usedStyles.has(displayStyle(row.style))) continue;
      const release = availableReleases[releaseIndex++];
      const liters = release?.workLiters || 2500;
      result.push({ id: `weekly-brew:${week}:${row.style}`, kind: "brew", status: "recommended", date: addDays(week, 1), style: row.style, tankId: "", liters, reason: Number.isFinite(row.cover) ? `מבין הסגנונות הזמינים, הכיסוי הצפוי הוא מהנמוכים ביותר (${row.cover.toFixed(1)} שבועות)` : "יש קיבולת בישול פנויה השבוע" } as BrewAction);
      usedStyles.add(displayStyle(row.style));
    }
    return result;
  }, [engineBrew, availableTankCount, current.brews, coreProducts, availableReleases, week, workspace.committedForecast]);

  const recommendedTruckSlots = useMemo(() => { const manifest = ship.flatMap((a) => a.pallets ?? []); if (!manifest.length) return 0; try { return calcTruckSlots(manifest); } catch { return 0; } }, [ship]);
  const decidedTruckSlots = () => { try { const manifest = (current.deliveries ?? []).flatMap((d) => { const p = product(d.productId); return p ? projectedPallets(p, d.quantity, d.id).map((x) => x.pallet) : []; }); return manifest.length ? calcTruckSlots(manifest) : 0; } catch { return 0; } };
  const draftTruckSlots = (qty: Record<string, number>) => { try { const manifest = coreProducts.flatMap((p) => projectedPallets(p, Math.max(0, qty[`ship:${p.id}`] ?? 0), `draft:${week}:${p.id}`).map((x) => x.pallet)); return manifest.length ? calcTruckSlots(manifest) : 0; } catch { return Infinity; } };

  function startEdit(kind: Kind) {
    setEditing(kind); setMessage(""); const qty: Record<string, number> = {};
    if (kind === "delivery") shipmentRows.forEach((r) => { qty[`ship:${r.p.id}`] = r.decidedQty || r.recommendedQty; });
    if (kind === "packaging") { current.packaging.forEach((r) => { qty[`saved:${r.id}`] = r.quantity; }); pack.forEach((a) => { qty[`rec:${a.id}`] = a.quantity; }); }
    if (kind === "brew") { const drafts: Record<string, BrewDraft> = {}; current.brews.forEach((b) => { drafts[`saved:${b.id}`] = { style: b.style, liters: b.liters }; }); brew.forEach((a) => { drafts[`rec:${a.id}`] = { style: a.style, liters: a.liters }; }); setBrewDraft(drafts); }
    setDraftQty(qty);
  }

  async function saveEdited(kind: Kind) {
    setBusy(true); setMessage("");
    try {
      let next = structuredClone(current);
      if (kind === "delivery") {
        if (draftTruckSlots(draftQty) > MAX_TRUCK_SLOTS) throw new Error(`המשלוח חורג מ־${MAX_TRUCK_SLOTS} מקומות במשאית`);
        const date = current.deliveries?.[0]?.dispatchDate ?? ship[0]?.date ?? addDays(week, 1); const deliveries: DeliveryPlan[] = [];
        for (const p of coreProducts) { const quantity = Math.max(0, Number(draftQty[`ship:${p.id}`] ?? 0)); if (quantity) deliveries.push({ id: crypto.randomUUID(), productId: p.id, quantity, dispatchDate: date, arrivalDate: date, truckId: `truck:${date}`, pallets: [] }); }
        next.deliveries = deliveries; next.deliveryDates = deliveries.length ? [date] : [];
      } else if (kind === "packaging") {
        next.packaging = next.packaging.map((r) => ({ ...r, quantity: Math.max(0, Number(draftQty[`saved:${r.id}`] ?? r.quantity)) })).filter((r) => r.quantity > 0);
        for (const a of pack) if (!next.packaging.some((x) => x.id === a.id)) {
          const quantity = Math.max(0, Number(draftQty[`rec:${a.id}`] ?? 0));
          if (quantity) {
            next = adoptAction(next, { ...a, quantity } as PlanningAction);
            const added = next.packaging[next.packaging.length - 1];
            const t = tanks.find((x) => x.id === added.tankId);
            const p = product(added.productId);
            if (t && p && t.liters - added.quantity * litersPerUnit(p) < 20) added.emptyTank = true;
          }
        }
      } else {
        next.brews = next.brews.map((b) => ({ ...b, tankId: "", ...(brewDraft[`saved:${b.id}`] ?? {}) }));
        for (const a of brew) if (!next.brews.some((x) => x.id === a.id)) { const d = brewDraft[`rec:${a.id}`]; if (d?.style && d.liters > 0) next.brews.push({ id: a.id, style: d.style, tankId: "", date: a.date, liters: d.liters }); }
      }
      next.changeReason = `עריכת החלטת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next); setEditing(null); setMessage("ההחלטה השבועית נשמרה.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); } finally { setBusy(false); }
  }

  async function accept(kind: Kind) {
    const selected: PlanningAction[] = kind === "packaging" ? pack as PlanningAction[] : kind === "brew" ? brew as PlanningAction[] : actions.filter((a) => a.kind === kind);
    if (!selected.length) return;
    setBusy(true); setMessage("");
    try {
      let next = structuredClone(current);
      for (const a of selected) {
        if (a.kind === "brew") {
          if (!next.brews.some((x) => x.id === a.id)) next.brews.push({ id: a.id, style: a.style, tankId: "", date: a.date, liters: a.liters });
        } else {
          const exists = a.kind === "packaging" ? next.packaging.some((x) => x.id === a.id) : (next.deliveries ?? []).some((x) => x.id === a.id);
          if (!exists) {
            next = adoptAction(next, a);
            if (a.kind === "packaging") {
              const added = next.packaging[next.packaging.length - 1];
              const t = tanks.find((x) => x.id === added.tankId);
              const p = product(added.productId);
              if (t && p && t.liters - added.quantity * litersPerUnit(p) < 20) added.emptyTank = true;
            }
          }
        }
      }
      next.changeReason = `אישור המלצת ${kind === "delivery" ? "משלוח" : kind === "packaging" ? "אריזה" : "בישול"} שבועית`;
      await saveWeek(next); setMessage("ההמלצה נשמרה כהחלטה שבועית.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "השמירה נכשלה"); } finally { setBusy(false); }
  }

  const stepPallets = (p: (typeof coreProducts)[number], delta: number) => setDraftQty((q) => {
    const key = `ship:${p.id}`;
    const next = { ...q, [key]: Math.max(0, (q[key] ?? 0) + delta * palletSize(p)) };
    if (delta > 0 && draftTruckSlots(next) > MAX_TRUCK_SLOTS) { setMessage(`המשאית מלאה: ${MAX_TRUCK_SLOTS}/${MAX_TRUCK_SLOTS} מקומות`); return q; }
    setMessage(""); return next;
  });

  return <section className="bp-weekly-planner">
    <div className="bp-section-heading"><div><h2>המלצות שבועיות</h2><p className="bp-muted">המתכנן מחליט כאן מה יקרה בשבוע; מנהל העבודה ישבץ אחר כך לימים ולמיכלים.</p></div></div>
    <div className="bp-week-picker">{Array.from({ length: 8 }, (_, i) => addDays(weekStart(today), i * 7)).map((w) => <button key={w} aria-pressed={week === w} onClick={() => { setWeek(w); setEditing(null); }}>שבוע {weekNumber(w)}<small>{shortDate(w)}</small></button>)}</div>
    {weekHolidays.length > 0 && <div className="bp-week-events"><b>חגים / מגבלות השבוע</b>{weekHolidays.map((h) => <span key={`${h.date}:${h.title}`}>{shortDate(h.date)} · {h.title}{h.closed ? " · סגור" : ""}</span>)}</div>}
    {warnings.length > 0 && <div className="bp-week-alerts"><b>אזהרות לתוכנית</b>{warnings.map((w) => <span key={w}>⚠ {w}</span>)}</div>}

    <div className="bp-week-recommendations">
      <article className="bp-week-rec-card bp-week-shipment-card">
        <header><div><small>1 · משלוח</small><h3>מה לשלוח השבוע</h3></div><b>{editing === "delivery" ? `${Math.min(MAX_TRUCK_SLOTS, draftTruckSlots(draftQty))}/${MAX_TRUCK_SLOTS}` : `${recommendedTruckSlots}/${MAX_TRUCK_SLOTS}`} מקומות</b></header>
        <p className="bp-rec-principle">הכיסוי הוא אומדן לסוף השבוע: המכירות נגרעות אוטומטית, ורק החלטות שנשמרו נכנסות לכיסוי. המלצה לבדה לא משנה שבוע עתידי.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>מומלץ</span><span>נקבע</span><span>זמין / תכנון</span></div>{shipmentRows.map((r) => <div className={`bp-shipment-plan-row is-${r.severity}`} key={r.p.id}>
          <span><b>{displayStyle(r.p.style)}</b><small>{r.p.type === "crates" ? "ארגזים" : "חביות"}{r.cover === null ? "" : ` · כיסוי סוף שבוע ${r.cover.toFixed(1)} שב׳`}</small></span>
          <span>{r.recPallets} מש׳<small>{r.recSlots} מק׳ במשאית</small></span>
          <span>{editing === "delivery" ? <div className="bp-stepper"><button type="button" onClick={() => stepPallets(r.p,-1)}>−</button><b>{Math.round((draftQty[`ship:${r.p.id}`] ?? 0) / palletSize(r.p))}</b><button type="button" onClick={() => stepPallets(r.p,1)}>+</button><small>משטחים</small></div> : <>{r.decidedPallets} מש׳</>}</span>
          <span>{r.availability.physicalPallets} מש׳<small>פיזי · ועוד {r.availability.plannedPallets} מש׳ מתכנון</small></span>
        </div>)}</div>
        <div className="bp-saved-summary">החלטה נוכחית: {decidedTruckSlots()}/{MAX_TRUCK_SLOTS} מקומות.</div>
        <div className="bp-actions">{editing === "delivery" ? <><button disabled={busy} onClick={() => saveEdited("delivery")}>שמירת החלטת המשלוח</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || recommendedTruckSlots < MAX_TRUCK_SLOTS} onClick={() => accept("delivery")}>קבל המלצת 12/12</button><button disabled={disabled || busy} onClick={() => startEdit("delivery")}>עריכת המשלוח</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>2 · אריזה</small><h3>מה לארוז השבוע</h3></div><b>{pack.length} המלצות · {remainingPackagingRuns} ימי אריזה פנויים</b></header>
        <p className="bp-rec-principle">המלצות האריזה מוגבלות לקיבולת השבוע. הן מדורגות לפי הכיסוי הצפוי מהחלטות בלבד — המלצה שלא התקבלה לא “מייצרת” מלאי בשבוע הבא.</p>
        <div className="bp-shipment-plan-table"><div className="bp-shipment-plan-head"><span>מקט</span><span>כיסוי</span><span>מומלץ</span><span>נקבע</span></div>{packagingRows.map((r) => <div className={`bp-shipment-plan-row is-${r.severity}`} key={r.p.id}><span><b>{displayStyle(r.p.style)}</b><small>{r.p.type === "crates" ? "ארגזים" : "חביות"}{r.tankText ? ` · מיכל ${r.tankText}` : ""}</small></span><span>{r.cover === null ? "—" : `${r.cover.toFixed(1)} שב׳`}</span><span>{fmt(r.recommendedQty)}</span><span>{fmt(r.decidedQty)}</span></div>)}</div>
        {editing === "packaging" && <div className="bp-decided-list"><b>עריכת החלטות האריזה</b>{current.packaging.map((r) => { const p = product(r.productId); return <div className="bp-rec-line" key={r.id}><b>{p ? displayStyle(p.style) : r.productId} · {fmt(r.quantity)} {p?.type === "crates" ? "ארגזים" : "חביות"}</b><button type="button" onClick={() => setDraftQty((q) => ({ ...q, [`saved:${r.id}`]: 0 }))}>הסר</button></div>; })}{pack.filter((a) => !current.packaging.some((x) => x.id === a.id)).map((a) => { const p = product(a.productId); return <div className="bp-rec-line" key={a.id}><b>{p ? displayStyle(p.style) : a.productId} · {fmt(a.quantity)}</b><button type="button" onClick={() => setDraftQty((q) => ({ ...q, [`rec:${a.id}`]: a.quantity }))}>הוסף</button></div>; })}</div>}
        <div className="bp-actions">{editing === "packaging" ? <><button disabled={busy} onClick={() => saveEdited("packaging")}>שמירת החלטת האריזה</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !pack.length} onClick={() => accept("packaging")}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => startEdit("packaging")}>עריכת האריזות</button></>}</div>
      </article>

      <article className="bp-week-rec-card">
        <header><div><small>3 · בישול</small><h3>מה לבשל השבוע</h3></div><b>{availableTankCount} מיכלים זמינים במהלך השבוע</b></header>
        <p className="bp-rec-principle">בישולים שנקבעו בשבועות קודמים תופסים מיכלים; מיכל שמתוכנן להתרוקן עד פחות מ־20 ל׳ משתחרר אחרי הניקיון ונכנס לקיבולת השבוע הבא.</p>
        <div className="bp-decided-list"><b>החלטות שנקבעו</b>{current.brews.length ? current.brews.map((b) => <div className="bp-rec-line" key={b.id}><b>{displayStyle(b.style)} · {fmt(b.liters)} ל׳</b><span>טרם שובץ למיכל</span>{editing === "brew" && <BrewEditRow value={brewDraft[`saved:${b.id}`] ?? { style: b.style, liters: b.liters }} onChange={(v) => setBrewDraft((d) => ({ ...d, [`saved:${b.id}`]: v }))}/>}</div>) : <small>טרם נקבע</small>}</div>
        <div className="bp-decided-list"><b>המלצת המערכת</b>{brew.length ? brew.map((a) => <div className="bp-rec-line" key={a.id}><b>{displayStyle(a.style)} · {fmt(a.liters)} ל׳</b><span>{a.reason}</span>{editing === "brew" && !current.brews.some((x) => x.id === a.id) && <BrewEditRow value={brewDraft[`rec:${a.id}`] ?? { style: a.style, liters: a.liters }} onChange={(v) => setBrewDraft((d) => ({ ...d, [`rec:${a.id}`]: v }))}/>}</div>) : <small>אין קיבולת בישול פנויה נוספת או שאין צורך נוסף</small>}</div>
        <div className="bp-actions">{editing === "brew" ? <><button disabled={busy} onClick={() => saveEdited("brew")}>שמירת החלטת הבישול</button><button onClick={() => setEditing(null)}>ביטול</button></> : <><button disabled={disabled || busy || !brew.length} onClick={() => accept("brew")}>קבל את ההמלצה</button><button disabled={disabled || busy} onClick={() => startEdit("brew")}>עריכת הבישולים</button></>}</div>
      </article>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}

function BrewEditRow({ value, onChange }: { value: BrewDraft; onChange: (value: BrewDraft) => void }) {
  return <div className="bp-brew-edit-row"><label>סגנון<select value={CORE_STYLES.some((s) => sameStyle(s, value.style)) ? displayStyle(value.style) : value.style} onChange={(e) => onChange({ ...value, style: e.target.value })}>{CORE_STYLES.map((s) => <option key={s} value={s}>{displayStyle(s)}</option>)}</select></label><label>ליטרים<input type="number" min="1" value={value.liters || ""} onChange={(e) => onChange({ ...value, liters: Number(e.target.value) })}/></label></div>;
}
