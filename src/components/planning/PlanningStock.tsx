    import { useState } from "react";
    import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
    import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";
    import {
    weeklyDemand,
    addDays,
    weekStart,
    inventory,
    usableInventory,
    type Settings,
    type WeekPlan,
    } from "../../SERVICES/planning/planningEngine";
    import {
    displayStyle,
    groupKey,
    styleGroups,
    } from "../../SERVICES/planning/planningPresentation";
    import { shortDate } from "../../SERVICES/planning/dailyPlanner";

    const fmt = (n: number) => n.toLocaleString("he-IL", { maximumFractionDigits: 0 });

    function cover(stock: number | null, daily: number) {
    if (!daily) return { label: "—", days: 0 };
    if (stock === null) return { label: "לא עודכן", days: 0 };
    const days = Math.max(0, Math.floor(stock / daily));
    return { label: days >= 7 ? `${(days / 7).toFixed(1)} שב׳` : `${days} ימים`, days };
    }

    function statusClass(status: string) {
    if (status === "נקבע") return "is-planned";
    if (status === "מסומן למשלוח") return "is-marked";
    return "is-recommended";
    }

    function measurementAge(today: string, date?: string) {
    if (!date) return Infinity;
    return Math.max(0, Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000));
    }

    function freshnessClass(age: number) {
    if (age >= 4) return "is-stale-critical";
    if (age >= 2) return "is-stale-warning";
    return "is-fresh";
    }

    export default function PlanningStock({ settings, pallets, today, plans }: {
    settings: Settings;
    pallets: Pallet[];
    today: string;
    plans: WeekPlan[];
    }) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const nextActions: { kind: string; date: string; group: string; description: string; status: string }[] = [];
    const undatedPackaging: { group: string; week: string; description: string }[] = [];

    const addProductAction = (kind: string, date: string, id: string, quantity: number, status: string) => {
        const p = settings.products.find((x) => x.id === id);
        if (p && date >= today && quantity > 0)
        nextActions.push({ kind, date, group: groupKey(p.style), description: `${fmt(quantity)} ${p.type === "crates" ? "ארגזים" : "חביות"}`, status });
    };

    // Stock overview intentionally shows only committed decisions.
    // Recommendations belong in the planning tabs; mixing them here can surface
    // stale suggestions after the real action was already completed.
    for (const w of plans) {
        // Dated commitments belong on the action calendar. Undated drafts
        // belong in a separate list and NEVER masquerade as Sunday shifts.
        w.packaging.filter((run) => !!run.date).forEach((r) =>
            addProductAction("packaging", r.date!, r.productId, r.quantity, "נקבע"));
        if (w.id >= weekStart(today)) {
            w.packaging.filter((run) => !run.date && run.quantity > 0).forEach((run) => {
                const product = settings.products.find((p) => p.id === run.productId);
                if (!product) return;
                undatedPackaging.push({
                    group: groupKey(product.style),
                    week: w.id,
                    description: `${fmt(run.quantity)} ${product.type === "crates" ? "ארגזים" : "חביות"}`,
                });
            });
        }
        (w.deliveries ?? []).forEach((d) => addProductAction("delivery", d.dispatchDate, d.productId, d.quantity, d.id.startsWith("marked:") ? "מסומן למשלוח" : "נקבע"));
        w.brews.filter((b) => b.date >= today).forEach((b) => nextActions.push({ kind: "brew", date: b.date, group: groupKey(b.style), description: `${fmt(b.liters)} ל׳`, status: "נקבע" }));
    }
    nextActions.sort((a, b) => a.date.localeCompare(b.date));

    const rows = styleGroups(settings)
        .filter((g) => g.products.some((p) => p.monthly > 0))
        .map((g) => ({
        ...g,
        formats: (["crates", "kegs"] as const).map((type) => {
            const product = g.products.find((p) => p.type === type);
            const inv = product ? inventory(product, pallets) : { brewery: 0, dock: 0 };
            const usableInv = product ? usableInventory(product, pallets, today) : { brewery: 0, dock: 0 };
            const brewery = inv.brewery + inv.dock;
            const usable = usableInv.brewery + usableInv.dock;
            const excluded = Math.max(0, brewery - usable);
            const tempo = product?.tempo ?? null;
            const daily = product ? weeklyDemand(product) / 7 : 0;
            const age = measurementAge(today, product?.tempoDate);
            return {
            type,
            product,
            brewery,
            usable,
            excluded,
            dock: inv.dock,
            tempo,
            daily,
            age,
            // Expired or missing-expiry stock is physically present but is NOT
            // sellable cover. Keep its quantity visible, distinctly excluded.
            breweryCover: cover(usable, daily),
            tempoCover: cover(tempo, daily),
            totalCover: cover(tempo === null ? null : tempo + usable, daily),
            };
        }),
        }));

    return (
        <section>
        <div className="bp-section-heading"><div><p className="bp-muted">מלאי טמפו כולל את צילום המלאי האחרון ואת המשלוחים שדווחו מאז אותו צילום. מלאי המבשלה מציג את כל המשטחים הפיזיים, כולל בהעמסה וממתינים לשיבוץ; רק משטחים בעלי תוקף מאומת נכללים בחישוב הכיסוי.</p></div></div>
        <div className="bp-stock-snapshot">
            {rows.map((g) => {
            const crates = g.formats.find((f) => f.type === "crates")!;
            const kegs = g.formats.find((f) => f.type === "kegs")!;
            const open = expanded === g.key;
            return (
                <article className={`bp-stock-snapshot-row ${open ? "is-open" : ""}`} key={g.key} role="button" tabIndex={0} aria-expanded={open}
                onClick={() => setExpanded((current) => current === g.key ? null : g.key)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((current) => current === g.key ? null : g.key); } }}>
                <div className={`bp-stock-style ${beerStyleClass(g.style).className}`}>{displayStyle(g.style)}
                    <small className="bp-stock-expand-hint">{open ? "סגירה ▴" : "פרטים נוספים ▾"}</small></div>
                {[crates, kegs].map((f) => (
                    <div className="bp-stock-metric" key={f.type}>
                    <small>{f.type === "crates" ? "ארגזים" : "חביות"}</small>
                    <div className="bp-stock-pair"><span><b>מבשלה</b> {fmt(f.brewery)} <small>(כשיר: {fmt(f.usable)})</small></span><span><b>טמפו</b> {f.tempo === null ? "—" : fmt(f.tempo)}</span></div>
                    <div className="bp-stock-coverage"><span>כיסוי כולל <strong>{f.totalCover.label}</strong></span><span>כיסוי מבשלה <strong>{f.breweryCover.label}</strong></span><span>כיסוי טמפו <strong>{f.tempoCover.label}</strong></span></div>
                    <i className={`bp-stock-freshness ${freshnessClass(f.age)}`}>{f.product?.tempoDate ? `עודכן ${shortDate(f.product.tempoDate)}` : "לא עודכן"}</i>
                    </div>
                ))}
                {open && (
                    <div className="bp-stock-detail" onClick={(e) => e.stopPropagation()}>
                    {g.formats.map((f) => (
                        <div key={f.type}>
                        <b>{f.type === "crates" ? "בקבוקים / ארגזים" : "חביות"}</b>
                        <span>מלאי פיזי במבשלה: {fmt(f.brewery)}</span>
                        <span>כשיר לכיסוי מלאי: {fmt(f.usable)}</span>
                        {f.excluded > 0 && <span role="alert">⚠️ {fmt(f.excluded)} יחידות ללא תוקף מאומת או פגות תוקף — אינן נכללות בכיסוי</span>}
                        <span>מלאי בטמפו: {f.tempo === null ? "לא עודכן" : fmt(f.tempo)}</span>
                        <span className={`bp-stock-freshness ${freshnessClass(f.age)}`}>{f.product?.tempoDate ? `עודכן לאחרונה: ${shortDate(f.product.tempoDate)}` : "לא קיימת מדידת טמפו"}</span>
                        <span>כיסוי במבשלה: {f.breweryCover.label}</span>
                        <span>כיסוי בטמפו: {f.tempoCover.label}</span>
                        <span>כיסוי כולל: {f.totalCover.label}</span>
                        {f.tempo !== null && f.daily > 0 && <small>בקצב הנוכחי הכיסוי הכולל יספיק עד {shortDate(addDays(today, f.totalCover.days))}</small>}
                        </div>
                    ))}
                    <div><b>פעולות קרובות</b>
                    {nextActions.filter((a) => a.group === g.key)
                    .slice(0, 6).map((a, i) => 
                    <span key={`${a.date}:${a.kind}:${i}`}>
                        {shortDate(a.date)} · {a.kind==="packaging"? "אריזה":a.kind==="brew"?"בישול":"משלוח"} - {a.description} · <b className={`bp-status-chip ${statusClass(a.status)}`}>{a.status}</b></span>)}{!nextActions.some((a) => a.group === g.key) && <span>אין פעולות מתוארכות בקרוב</span>}</div>
                    {undatedPackaging.some((a) => a.group === g.key) && <div><b>אריזות ללא יום ביצוע — אינן זמינות עדיין למשלוח</b>
                    {undatedPackaging.filter((a) => a.group === g.key).map((a, i) =>
                      <span key={`draft:${a.week}:${i}`}>שבוע {shortDate(a.week)} · {a.description} · טרם שובץ</span>)}</div>}
                    </div>
                )}
                </article>
            );
            })}
        </div>
        </section>
    );
    }
