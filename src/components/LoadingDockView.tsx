import { useEffect, useMemo, useState } from "react";
import { subscribeToZone, createShipment, moveToZone } from "../SERVICES/Palletservice";
import type { Pallet } from "../SERVICES/Pallettypes ";

function useTotals(pallets: Pallet[]) {
    return useMemo(() => {
        const map = new Map<string, { itemType: string; beerStyle: string; totalQuantity: number }>();
        pallets.forEach((p) => {
            const key = `${p.itemType}__${p.beerStyle}`;
            const cur = map.get(key);
            if (cur) cur.totalQuantity += p.quantity;
            else map.set(key, { itemType: p.itemType, beerStyle: p.beerStyle, totalQuantity: p.quantity });
        });
        return Array.from(map.values());
    }, [pallets]);
}

export default function LoadingDockView() {
    const [pallets, setPallets] = useState<Pallet[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastShipmentId, setLastShipmentId] = useState<string | null>(null);

    useEffect(() => subscribeToZone("loadingDock", setPallets), []);
    const totals = useTotals(pallets.filter((p) => selected.has(p.id)));

    async function returnToPending(id: string) {
        try { setError(null); await moveToZone(id, "pending"); setSelected((s) => { const n = new Set(s); n.delete(id); return n; }); }
        catch (e: any) { setError(e?.message ?? "שגיאה בהעברה"); }
    }

    async function handleShip() {
        setBusy(true); setError(null);
        try { const id = await createShipment(Array.from(selected)); setLastShipmentId(id); setSelected(new Set()); }
        catch (e: any) { setError(e?.message ?? "שגיאה בשילוח"); }
        finally { setBusy(false); }
    }

    if (pallets.length === 0) return <div className="zone-tray-empty">אין משטחים במשטח הטעינה כרגע.</div>;

    return (
        <div className="loading-dock-view">
            <div className="zone-tray-header"><div><h3>משטח טעינה</h3><p>בחר משטחים שנשלחו. לחץ שלח לניפוק תעודת משלוח.</p></div></div>
            <div className="dock-list">
                {pallets.map((p) => (
                    <article key={p.id} className="dock-card">
                        <label className="dock-select"><input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} /><span>בחר למשלוח</span></label>
                        <div className="dock-card-info"><strong>{p.beerStyle}{p.subLabel ? ` · ${p.subLabel}` : ""}</strong><span>{p.quantity} {p.itemType === "kegs" ? "חביות" : "ארגזים"}{p.batchNumber ? ` · אצווה ${p.batchNumber}` : ""}</span></div>
                        <button className="zone-secondary-action" onClick={() => returnToPending(p.id)}>החזר ל"ממתינים לשיבוץ"</button>
                    </article>
                ))}
            </div>
            {totals.length > 0 && <table className="dock-summary"><thead><tr><th>סגנון</th><th>סוג</th><th>סה״כ</th></tr></thead><tbody>{totals.map((t) => <tr key={t.beerStyle + t.itemType}><td>{t.beerStyle}</td><td>{t.itemType === "kegs" ? "חביות" : "ארגזים"}</td><td>{t.totalQuantity}</td></tr>)}</tbody></table>}
            {error && <div className="edit-specs-message error">{error}</div>}
            {lastShipmentId && <div className="edit-specs-message success">תעודת משלוח נוצרה ({lastShipmentId})</div>}
            <button className="shipment-btn" disabled={busy || selected.size === 0} onClick={handleShip}>{busy ? "יוצר תעודה…" : `שלח ${selected.size ? `(${selected.size})` : ""}`}</button>
        </div>
    );
}
