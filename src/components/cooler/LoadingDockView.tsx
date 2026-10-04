import { useEffect, useMemo, useState } from "react";
import type { Pallet } from "../../SERVICES/cooler/Pallettypes ";
import ShipmentDocumentModal from "./ShipmentDocumentModal";
import {
    createShipment,
    getShipmentCustomerSuggestions,
    moveToZone,
    calcTruckSlots,
    MAX_TRUCK_SLOTS,
    type ShipmentCustomerOption,
} from "../../SERVICES/cooler/Palletservice";
import BeerLoader from "../general/Loading";
import { getCatalogEntry } from "../../SERVICES/cooler/PalletCatalog";

function useTotals(pallets: Pallet[]) {
    return useMemo(() => {
        const map = new Map<string, { itemType: string; beerStyle: string; totalQuantity: number }>();
        pallets.forEach((p) => {
            const entry = getCatalogEntry(p.beerStyle, p.itemType);
            const key = entry?.sku ? `sku__${entry.sku}` : `${p.itemType}__${p.beerStyle.trim().toLowerCase()}`;
            const current = map.get(key);
            if (current) current.totalQuantity += p.quantity;
            else map.set(key, { itemType: p.itemType, beerStyle: entry?.displayText ?? p.beerStyle, totalQuantity: p.quantity });
        });
        return Array.from(map.values());
    }, [pallets]);
}

function normalizeCustomer(value: string) {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("he-IL");
}

function editDistance(a: string, b: string) {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j += 1) {
        let previous = rows[0];
        rows[0] = j;
        for (let i = 1; i <= a.length; i += 1) {
            const saved = rows[i];
            rows[i] = Math.min(rows[i] + 1, rows[i - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = saved;
        }
    }
    return rows[a.length];
}

function looksLikeTempoTypo(value: string) {
    const normalized = normalizeCustomer(value).replace(/[^a-zא-ת]/gi, "");
    if (!normalized || normalized === "טמפו" || normalized === "tempo") return false;
    return editDistance(normalized, "טמפו") <= 1 || editDistance(normalized, "tempo") <= 1;
}

export default function LoadingDockView({ pallets }: { pallets: Pallet[] }) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [busyAction, setBusyAction] = useState<"return" | "ship" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastShipmentId, setLastShipmentId] = useState<string | null>(null);
    const [shipmentPallets, setShipmentPallets] = useState<Pallet[]>([]);
    const [showShipmentDocument, setShowShipmentDocument] = useState(false);
    const [showCustomerModal, setShowCustomerModal] = useState(false);
    const [customerName, setCustomerName] = useState("");
    const [customerId, setCustomerId] = useState<string | null>(null);
    const [customerOptions, setCustomerOptions] = useState<ShipmentCustomerOption[]>([{ name: "טמפו", customerId: "tempo" }]);
    const [lastCustomerName, setLastCustomerName] = useState<string | null>(null);

    useEffect(() => {
        if (!showCustomerModal) return;
        let cancelled = false;
        getShipmentCustomerSuggestions()
            .then((options) => { if (!cancelled) setCustomerOptions(options); })
            .catch(() => { /* Tempo remains available even if history cannot load. */ });
        return () => { cancelled = true; };
    }, [showCustomerModal]);

    const selectedPallets = useMemo(() => pallets.filter((p) => selected.has(p.id)), [pallets, selected]);
    const totalTruckSlots = useMemo(() => calcTruckSlots(pallets), [pallets]);
    const selectedTruckSlots = useMemo(() => calcTruckSlots(selectedPallets), [selectedPallets]);
    const totalTruckOverCapacity = totalTruckSlots > MAX_TRUCK_SLOTS;
    const selectedTruckOverCapacity = selectedTruckSlots > MAX_TRUCK_SLOTS;
    const allSelected = pallets.length > 0 && pallets.every((p) => selected.has(p.id));
    const totals = useTotals(pallets);

    function selectCustomer(value: string) {
        setCustomerName(value);
        const normalized = normalizeCustomer(value);
        const exact = customerOptions.find((option) => normalizeCustomer(option.name) === normalized);
        setCustomerId(exact?.customerId ?? (normalized === "טמפו" || normalized === "tempo" ? "tempo" : null));
    }

    function togglePallet(id: string) {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    function toggleSelectAll() {
        setSelected(allSelected ? new Set() : new Set(pallets.map((p) => p.id)));
    }

    async function returnToPending(id: string) {
        setBusy(true);
        setBusyAction("return");
        setError(null);
        try {
            await moveToZone(id, "pending");
            setSelected((current) => { const next = new Set(current); next.delete(id); return next; });
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "שגיאה בהעברת המשטח");
        } finally {
            setBusy(false);
            setBusyAction(null);
        }
    }

    async function handleShip() {
        if (selected.size === 0) return;
        const trimmedName = customerName.trim();
        if (!trimmedName) return;
        setBusy(true);
        setBusyAction("ship");
        setError(null);
        try {
            const palletsForShipment = pallets.filter((p) => selected.has(p.id));
            const shipmentId = await createShipment(palletsForShipment.map((p) => p.id), trimmedName, customerId);
            setLastShipmentId(shipmentId);
            setLastCustomerName(trimmedName);
            setShipmentPallets(palletsForShipment);
            setShowShipmentDocument(true);
            setShowCustomerModal(false);
            setSelected(new Set());
            setCustomerName("");
            setCustomerId(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "שגיאה בשילוח");
        } finally {
            setBusy(false);
            setBusyAction(null);
        }
    }

    if (pallets.length === 0 && !showShipmentDocument) return <div className="zone-tray-empty">אין משטחים במשטח הטעינה כרגע.</div>;

    return (
        <div className="loading-dock-view" dir="rtl">
            <div className="zone-tray-header">
                <div><h3>משטח טעינה</h3><p>בחר משטחים שנשלחו. לחץ שלח לניפוק תעודת משלוח.</p></div>
                {pallets.length > 0 && <button type="button" className="bulk-mode-btn" onClick={toggleSelectAll} disabled={busy}>{allSelected ? "בטל בחירת הכל" : "בחר הכל"}</button>}
            </div>

            <div className={`truck-capacity-indicator ${totalTruckOverCapacity ? "over-capacity" : ""}`} dir="rtl">
                <div className="truck-capacity-icon">🚚</div>
                <div className="truck-capacity-info"><strong>תפוסת המשאית</strong><span>{totalTruckSlots} / {MAX_TRUCK_SLOTS} מקומות</span></div>
                <div className="truck-capacity-bar"><div className="truck-capacity-bar-fill" style={{ width: `${Math.min(100, (totalTruckSlots / MAX_TRUCK_SLOTS) * 100)}%` }} /></div>
                {totalTruckOverCapacity && <div className="truck-capacity-warning">⚠️ חרגת מקיבולת המשאית ב־{totalTruckSlots - MAX_TRUCK_SLOTS} מקומות</div>}
            </div>

            {selected.size > 0 && <div className={`truck-capacity-indicator ${selectedTruckOverCapacity ? "over-capacity" : ""}`} dir="rtl">
                <div className="truck-capacity-icon">📦</div>
                <div className="truck-capacity-info"><strong>הבחירה למשלוח</strong><span>{selectedTruckSlots} / {MAX_TRUCK_SLOTS} מקומות</span></div>
                <div className="truck-capacity-bar"><div className="truck-capacity-bar-fill" style={{ width: `${Math.min(100, (selectedTruckSlots / MAX_TRUCK_SLOTS) * 100)}%` }} /></div>
                {selectedTruckOverCapacity && <div className="truck-capacity-warning">⚠️ הבחירה חורגת מקיבולת המשאית ב־{selectedTruckSlots - MAX_TRUCK_SLOTS} מקומות</div>}
            </div>}

            <div className="dock-list">
                {pallets.map((pallet) => {
                    const isSelected = selected.has(pallet.id);
                    return <article key={pallet.id} className={`dock-card ${isSelected ? "selected" : ""}`}>
                        <label className="dock-select"><input type="checkbox" checked={isSelected} disabled={busy} onChange={() => togglePallet(pallet.id)} /><span>בחר למשלוח</span></label>
                        <div className="dock-card-info"><strong>{pallet.beerStyle}{pallet.subLabel ? ` · ${pallet.subLabel}` : ""}</strong><span>{pallet.quantity} {pallet.itemType === "kegs" ? "חביות" : "ארגזים"}{pallet.batchNumber ? ` · אצווה ${pallet.batchNumber}` : ""}</span></div>
                        <button type="button" className="zone-secondary-action" onClick={() => returnToPending(pallet.id)} disabled={busy}>{busyAction === "return" ? <BeerLoader message="מעביר..." size="spinner" /> : 'החזר ל"ממתינים לשיבוץ"'}</button>
                    </article>;
                })}
            </div>

            {totals.length > 0 && <table className="dock-summary"><thead><tr><th>סגנון</th><th>סוג</th><th>סה״כ</th></tr></thead><tbody>{totals.map((total) => <tr key={`${total.beerStyle}-${total.itemType}`}><td>{total.beerStyle}</td><td>{total.itemType === "kegs" ? "חביות" : "ארגזים"}</td><td>{total.totalQuantity}</td></tr>)}</tbody></table>}

            {error && <div className="edit-specs-message error">{error}</div>}
            {lastShipmentId && <div className="edit-specs-message success">תעודת משלוח נוצרה ({lastShipmentId})</div>}

            <button type="button" className={`shipment-btn ${selectedTruckOverCapacity ? "shipment-btn-over-capacity" : ""}`} disabled={busy || selected.size === 0} onClick={() => setShowCustomerModal(true)}>
                {busyAction === "ship" ? <BeerLoader message="יוצר תעודה" overlay={false} size="spinner" /> : `שלח${selected.size ? ` (${selected.size})` : ""}`}
            </button>

            {showCustomerModal && <div className="modal-overlay" onClick={() => !busy && setShowCustomerModal(false)}>
                <div className="customer-name-modal" dir="rtl" onClick={(e) => e.stopPropagation()}>
                    <h3>לכבוד</h3>
                    <p>בחר לקוח קיים או הקלד שם חדש.</p>
                    <input type="text" list="shipment-customer-options" value={customerName} autoFocus placeholder="שם הלקוח" disabled={busy} onChange={(e) => selectCustomer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && customerName.trim() && !looksLikeTempoTypo(customerName)) handleShip(); }} />
                    <datalist id="shipment-customer-options">{customerOptions.map((option) => <option key={`${option.customerId ?? "name"}:${option.name}`} value={option.name} />)}</datalist>
                    {customerId === "tempo" && <small className="edit-specs-message success">✓ טמפו זוהה כלקוח טמפו לצורך התכנון.</small>}
                    {customerId !== "tempo" && looksLikeTempoTypo(customerName) && <div className="edit-specs-message error">נראה שהתכוונת לטמפו. בחר “טמפו” מהרשימה כדי שהמשלוח ייספר בתכנון טמפו.</div>}
                    <div className="customer-name-modal-actions">
                        <button type="button" onClick={() => setShowCustomerModal(false)} disabled={busy}>ביטול</button>
                        <button type="button" className="shipment-btn" onClick={handleShip} disabled={!customerName.trim() || busy || (customerId !== "tempo" && looksLikeTempoTypo(customerName))}>{busyAction === "ship" ? <BeerLoader message="יוצר תעודה" overlay={false} size="spinner" /> : "אשר ושלח"}</button>
                    </div>
                    {error && <div className="edit-specs-message error">{error}</div>}
                </div>
            </div>}

            {showShipmentDocument && <ShipmentDocumentModal shipmentId={lastShipmentId!} pallets={shipmentPallets} customerName={lastCustomerName} onClose={() => setShowShipmentDocument(false)} />}
        </div>
    );
}
