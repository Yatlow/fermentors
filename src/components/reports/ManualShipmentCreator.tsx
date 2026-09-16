import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { createManualShipment } from "../../SERVICES/cooler/manualShipment";
import { getShipmentCatalogOptions } from "../../SERVICES/cooler/PalletCatalog";
import { getShipmentCustomerSuggestions, type ShipmentCustomerOption } from "../../SERVICES/cooler/Palletservice";
import type { ManualShipmentLine } from "../../SERVICES/cooler/Pallettypes ";
import BeerLoader from "../general/Loading";

type DraftLine = ManualShipmentLine & {
    catalogKey: string;
};

type Props = {
    onClose: () => void;
    onCreated: (shipmentId: string) => void;
};

function newLine(): DraftLine {
    return {
        id: crypto.randomUUID(),
        sku: "",
        description: "",
        quantity: 1,
        source: "catalog",
        catalogKey: "",
    };
}

function customerKey(value: string) {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("he-IL");
}

export default function ManualShipmentCreator({ onClose, onCreated }: Props) {
    const catalog = useMemo(() => getShipmentCatalogOptions(), []);
    const [customerName, setCustomerName] = useState("");
    const [customerOptions, setCustomerOptions] = useState<ShipmentCustomerOption[]>([{ name: "טמפו", customerId: "tempo" }]);
    const [lines, setLines] = useState<DraftLine[]>([newLine()]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        getShipmentCustomerSuggestions()
            .then((options) => { if (!cancelled) setCustomerOptions(options); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    const selectedCustomer = useMemo(() => {
        const key = customerKey(customerName);
        return customerOptions.find((option) => customerKey(option.name) === key) ?? null;
    }, [customerName, customerOptions]);

    const validLines = useMemo(
        () => lines.filter((line) => line.description.trim() && Number(line.quantity) > 0),
        [lines],
    );
    const canSave = !!customerName.trim() && validLines.length > 0 && !saving;

    function updateLine(id: string, patch: Partial<DraftLine>) {
        setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
    }

    function selectCatalog(id: string, value: string) {
        if (value === "__manual__") {
            updateLine(id, { catalogKey: value, source: "manual", sku: "", description: "" });
            return;
        }
        const option = catalog.find((item) => `${item.sku}__${item.itemType}` === value);
        if (!option) {
            updateLine(id, { catalogKey: "", sku: "", description: "", source: "catalog" });
            return;
        }
        updateLine(id, { catalogKey: value, source: "catalog", sku: option.sku, description: option.displayText });
    }

    async function save() {
        if (!canSave) {
            if (!customerName.trim()) setError("יש להזין שם לקוח");
            else if (!validLines.length) setError("יש להוסיף לפחות פריט אחד");
            return;
        }
        setError("");
        setSaving(true);
        try {
            const shipmentId = await createManualShipment(
                validLines.map(({ catalogKey: _catalogKey, ...line }) => line),
                customerName,
                selectedCustomer?.customerId ?? null,
            );
            onCreated(shipmentId);
        } catch (err) {
            setError(err instanceof Error ? err.message : "יצירת תעודת המשלוח נכשלה");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={() => !saving && onClose()}>
            <section className="customer-name-modal" dir="rtl" style={{ width: "min(860px, calc(100vw - 24px))", maxHeight: "88vh", overflow: "auto" }} onClick={(event) => event.stopPropagation()}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div><h3 style={{ marginBottom: 4 }}>תעודת משלוח חדשה</h3><p style={{ marginTop: 0 }}>בחר פריטים מהקטלוג או הוסף פריט חופשי.</p></div>
                    <button type="button" onClick={onClose} disabled={saving} aria-label="סגור"><X size={20} /></button>
                </div>

                <label className="spec-field" style={{ marginBottom: 16 }}>
                    <span className="spec-field-label">לכבוד</span>
                    <input className="spec-input" style={{ minWidth: 280 }} list="shipment-customer-options" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="בחר לקוח קודם או הקלד שם חדש" />
                    <datalist id="shipment-customer-options">
                        {customerOptions.map((option) => <option key={`${option.customerId ?? "name"}:${option.name}`} value={option.name} />)}
                    </datalist>
                </label>

                <div style={{ display: "grid", gap: 12 }}>
                    {lines.map((line) => (
                        <div key={line.id} style={{ border: "1px solid #dbe3ec", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
                            <label className="spec-field">
                                <span className="spec-field-label">פריט</span>
                                <select className="spec-input" style={{ minWidth: 320 }} value={line.catalogKey} onChange={(event) => selectCatalog(line.id, event.target.value)}>
                                    <option value="">בחר מהקטלוג</option>
                                    {catalog.map((option) => <option key={`${option.sku}-${option.itemType}`} value={`${option.sku}__${option.itemType}`}>{option.sku} · {option.displayText}</option>)}
                                    <option value="__manual__">פריט אחר / הזנה ידנית</option>
                                </select>
                            </label>

                            {line.source === "manual" && <>
                                <label className="spec-field"><span className="spec-field-label">מק״ט</span><input className="spec-input" value={line.sku} onChange={(event) => updateLine(line.id, { sku: event.target.value })} /></label>
                                <label className="spec-field"><span className="spec-field-label">תיאור פריט</span><input className="spec-input" value={line.description} onChange={(event) => updateLine(line.id, { description: event.target.value })} /></label>
                            </>}

                            {line.source === "catalog" && line.description && <div style={{ fontSize: 14 }}><strong>{line.sku}</strong> · {line.description}</div>}

                            <div style={{ display: "flex", gap: 10, alignItems: "end" }}>
                                <label className="spec-field" style={{ flex: 1 }}><span className="spec-field-label">כמות</span><input className="spec-input" type="number" min={1} step="any" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) || 0 })} /></label>
                                <button type="button" className="removeEmailBtn" disabled={saving || lines.length === 1} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} title="הסר פריט"><Trash2 size={18} /></button>
                            </div>
                        </div>
                    ))}
                </div>

                <button type="button" style={{ marginTop: 12 }} onClick={() => setLines((current) => [...current, newLine()])} disabled={saving}><Plus size={18} /> הוסף פריט</button>
                {error && <div className="edit-specs-message error" style={{ marginTop: 12 }}>{error}</div>}
                <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end" }}>
                    <button type="button" onClick={onClose} disabled={saving}>ביטול</button>
                    <button type="button" className="btn-primary" onClick={() => void save()} disabled={!canSave}>{saving ? <BeerLoader message="יוצר תעודה..." size="spinner" /> : "צור תעודת משלוח"}</button>
                </div>
            </section>
        </div>
    );
}
