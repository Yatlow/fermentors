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
import { getCatalogEntry, getShipmentCatalogOptions } from "../../SERVICES/cooler/PalletCatalog";
import { compareDispatchManifests } from "../../SERVICES/planning/shipmentDispatchVariance";
import { loadPlannedDispatchTrips, type PlannedDispatchTrip } from
    "../../SERVICES/planning/shipmentDispatchIdentity";

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
    const [plannedTrips, setPlannedTrips] = useState<PlannedDispatchTrip[]>([]);
    const [plannedTripChoice, setPlannedTripChoice] = useState("");
    const [plannedTripsLoading, setPlannedTripsLoading] = useState(false);
    const [plannedTripsError, setPlannedTripsError] = useState("");
    const [varianceApproved, setVarianceApproved] = useState(false);
    const dispatchLabels = useMemo(() => new Map(getShipmentCatalogOptions().map((item) => [
        item.sku, `${item.beerStyle} (${item.itemType === "kegs" ? "חביות" : "ארגזים"})`,
    ])), []);

    useEffect(() => {
        if (!showCustomerModal) return;
        let cancelled = false;
        getShipmentCustomerSuggestions()
            .then((options) => { if (!cancelled) setCustomerOptions(options); })
            .catch(() => { /* Tempo remains available even if history cannot load. */ });
        return () => { cancelled = true; };
    }, [showCustomerModal]);

    const selectedPallets = useMemo(() => pallets.filter((p) => selected.has(p.id)), [pallets, selected]);
    const actualDispatchManifest = useMemo(() => selectedPallets.map((pallet) => ({
        productId: getCatalogEntry(pallet.beerStyle, pallet.itemType)?.sku ??
            `__unmapped__:${pallet.itemType}:${pallet.beerStyle.trim().toLocaleLowerCase("he-IL")}`,
        quantity: Number(pallet.quantity),
    })), [selectedPallets]);
    const selectedTrip = plannedTrips.find((trip) => trip.id === plannedTripChoice) ?? null;
    const varianceRows = useMemo(() => selectedTrip
        ? compareDispatchManifests(selectedTrip.manifest, actualDispatchManifest)
        : [], [selectedTrip, actualDispatchManifest]);
    const labelForSku = (productId: string) => {
        const pallet = selectedPallets.find((item) =>
            (getCatalogEntry(item.beerStyle, item.itemType)?.sku ??
                `__unmapped__:${item.itemType}:${item.beerStyle.trim().toLocaleLowerCase("he-IL")}`) === productId);
        return pallet
            ? `${pallet.beerStyle} (${pallet.itemType === "kegs" ? "חביות" : "ארגזים"})`
            : dispatchLabels.get(productId) ?? `מק״ט ${productId}`;
    };
    useEffect(() => { setVarianceApproved(false); },
        [showCustomerModal, customerId, plannedTripChoice, selectedPallets]);
    const taggedAutoTrip = useMemo(() => {
        const ids = new Set(selectedPallets.map((p) =>
            p.markedForShipment && p.autoReservationTruckId ? p.autoReservationTruckId : ""));
        return ids.size === 1 && !ids.has("") ? [...ids][0] : null;
    }, [selectedPallets]);
    useEffect(() => {
        if (!showCustomerModal || customerId !== "tempo") {
            setPlannedTrips([]);
            setPlannedTripChoice("");
            setPlannedTripsError("");
            setPlannedTripsLoading(false);
            return;
        }
        let cancelled = false;
        setPlannedTripsLoading(true);
        setPlannedTripsError("");
        loadPlannedDispatchTrips().then((trips) => {
            if (cancelled) return;
            setPlannedTrips(trips);
            // Keep dispatch moving: select the only real trip automatically.
            // With several trips, a physical auto-reservation can identify the
            // truck; otherwise the operator must choose the correct truck.
            setPlannedTripChoice(trips.some((trip) => trip.id === taggedAutoTrip)
                ? taggedAutoTrip! : trips.length === 1 ? trips[0].id : "");
        }).catch(() => {
            if (!cancelled) setPlannedTripsError("לא ניתן לבדוק את נסיעות טמפו המתוכננות. יש לבדוק חיבור ולפתוח מחדש.");
        }).finally(() => {
            if (!cancelled) setPlannedTripsLoading(false);
        });
        return () => { cancelled = true; };
    }, [showCustomerModal, customerId, taggedAutoTrip]);
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
        if (selectedTruckOverCapacity) {
            setError("המשאית חורגת מ-12 מקומות; יש לצמצם את המשטחים לפני שילוח.");
            return;
        }
        const trimmedName = customerName.trim();
        if (!trimmedName) return;
        if (customerId === "tempo") {
            if (plannedTripsLoading || plannedTripsError) {
                setError(plannedTripsError || "יש להמתין לטעינת הנסיעות המתוכננות");
                return;
            }
            if (plannedTrips.length && !selectedTrip) {
                setError("יש לבחור איזו נסיעה מתוכננת יוצאת בפועל.");
                return;
            }
            if (selectedTrip && varianceRows.length > 0 && !varianceApproved) {
                setError("יש לאשר את הפער בין התכנון להעמסה בפועל לפני השליחה.");
                return;
            }
        }
        setBusy(true);
        setBusyAction("ship");
        setError(null);
        try {
            const palletsForShipment = pallets.filter((p) => selected.has(p.id));
            const shipmentId = await createShipment(
                palletsForShipment.map((p) => p.id), trimmedName, customerId,
                customerId === "tempo" ? selectedTrip?.id ?? false : null,
                {
                    pallets: selectedPallets.map(({ id, quantity, itemType, beerStyle }) => ({
                        id, quantity, itemType, beerStyle,
                    })),
                    plannedManifest: selectedTrip?.manifest ?? null,
                },
            );
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

            <button type="button" className={`shipment-btn ${selectedTruckOverCapacity ? "shipment-btn-over-capacity" : ""}`} disabled={busy || selected.size === 0 || selectedTruckOverCapacity} onClick={() => setShowCustomerModal(true)}>
                {busyAction === "ship" ? <BeerLoader message="יוצר תעודה" overlay={false} size="spinner" /> : `שלח${selected.size ? ` (${selected.size})` : ""}`}
            </button>

            {showCustomerModal && <div className="modal-overlay" onClick={() => !busy && setShowCustomerModal(false)}>
                <div className="customer-name-modal" dir="rtl" onClick={(e) => e.stopPropagation()}>
                    <h3>לכבוד</h3>
                    <p>בחר לקוח קיים או הקלד שם חדש.</p>
                    <input type="text" list="shipment-customer-options" value={customerName} autoFocus placeholder="שם הלקוח" disabled={busy} onChange={(e) => selectCustomer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && customerName.trim() && !looksLikeTempoTypo(customerName)) void handleShip(); }} />
                    <datalist id="shipment-customer-options">{customerOptions.map((option) => <option key={`${option.customerId ?? "name"}:${option.name}`} value={option.name} />)}</datalist>
                    {customerId === "tempo" && <>
                        <small className="edit-specs-message success">✓ טמפו זוהה כלקוח טמפו לצורך התכנון.</small>
                        {plannedTripsLoading && <small>בודק נסיעות טמפו פתוחות להיום…</small>}
                        {plannedTripsError && <div className="edit-specs-message error">{plannedTripsError}</div>}
                        {!plannedTripsLoading && !plannedTripsError && plannedTrips.length > 0 &&
                            <label className="spec-field">
                                <span className="spec-field-label">שיוך לתכנון — איזו משאית יוצאת בפועל?</span>
                                <select className="spec-input" value={plannedTripChoice}
                                    onChange={(event) => setPlannedTripChoice(event.target.value)}>
                                    <option value="">בחר נסיעה מתוכננת</option>
                                    {plannedTrips.map((trip, index) => <option key={trip.id} value={trip.id}>
                                        {index + 1}. {trip.date} · {trip.manifest.map((line) =>
                                            `${line.productId}: ${line.quantity}`).join(", ")}
                                    </option>)}
                                </select>
                            </label>}
                        {selectedTrip && varianceRows.length === 0 &&
                            <small className="edit-specs-message success">✓ הכמויות שנבחרו למשלוח תואמות לתכנון.</small>}
                        {selectedTrip && varianceRows.length > 0 && (
                            <section aria-label="פערים בין התכנון למשלוח" style={{
                                border: "1px solid #e7b15c", background: "#fff9ed",
                                borderRadius: 12, padding: 12, color: "#563b12",
                            }}>
                                <strong>הכמויות שונות מהתכנון</strong>
                                <p style={{ margin: "6px 0 10px" }}>זה בסדר לשלוח כמות אחרת. בדוק ואשר את הפערים:</p>
                                <div style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "right", fontSize: 13 }}>
                                        <thead><tr><th>מוצר</th><th>תוכנן</th><th>בפועל</th><th>פער</th></tr></thead>
                                        <tbody>{varianceRows.map((line) => (
                                            <tr key={line.productId}>
                                                <td style={{ padding: "6px 2px" }}>{labelForSku(line.productId)}</td>
                                                <td>{line.planned}</td>
                                                <td>{line.actual}</td>
                                                <td style={{ fontWeight: 700, whiteSpace: "nowrap" }} dir="ltr">
                                                    {line.difference > 0 ? "+" : ""}{line.difference}
                                                </td>
                                            </tr>
                                        ))}</tbody>
                                    </table>
                                </div>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
                                    <input type="checkbox" checked={varianceApproved} disabled={busy}
                                        onChange={(event) => setVarianceApproved(event.target.checked)} />
                                    <span>בדקתי את הפער ואני מאשר לשלוח את הכמויות בפועל.</span>
                                </label>
                                <small>הנסיעה תישאר משויכת לתכנון ותסומן כבוצעה בהרכב שונה.</small>
                            </section>
                        )}
                        {!plannedTripsLoading && !plannedTripsError && plannedTrips.length === 0 &&
                            <small>לא נמצאה נסיעה מתוכננת לטמפו היום. אפשר לשלוח כרגיל; המשלוח יירשם כביצוע נוסף.</small>}
                    </>}
                    {customerId !== "tempo" && looksLikeTempoTypo(customerName) && <div className="edit-specs-message error">נראה שהתכוונת לטמפו. בחר “טמפו” מהרשימה כדי שהמשלוח ייספר בתכנון טמפו.</div>}
                    <div className="customer-name-modal-actions">
                        <button type="button" onClick={() => setShowCustomerModal(false)} disabled={busy}>ביטול</button>
                        <button type="button" className="shipment-btn" onClick={() => void handleShip()} disabled={!customerName.trim() || busy ||
                            (customerId === "tempo" && (plannedTripsLoading || !!plannedTripsError ||
                                (plannedTrips.length > 0 && (!selectedTrip ||
                                    (varianceRows.length > 0 && !varianceApproved))))) ||
                            (customerId !== "tempo" && looksLikeTempoTypo(customerName))}>{busyAction === "ship" ? <BeerLoader message="יוצר תעודה" overlay={false} size="spinner" />
                            : selectedTrip && varianceRows.length > 0 ? "מאשר פער ושולח" : "אשר ושלח"}</button>
                    </div>
                    {error && <div className="edit-specs-message error">{error}</div>}
                </div>
            </div>}

            {showShipmentDocument && <ShipmentDocumentModal shipmentId={lastShipmentId!} pallets={shipmentPallets} customerName={lastCustomerName} onClose={() => setShowShipmentDocument(false)} />}
        </div>
    );
}
