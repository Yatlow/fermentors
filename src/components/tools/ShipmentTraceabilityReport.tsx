import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, onSnapshot } from "firebase/firestore";
import { Download, Search } from "lucide-react";
import { db } from "../../firebase";
import { getCatalogEntry } from "../../SERVICES/cooler/PalletCatalog";
import type { Pallet, Shipment } from "../../SERVICES/cooler/Pallettypes ";
import {
    buildShipmentTraceability,
    displayShipmentExpiry,
    type ShipmentLotRow,
    type ShipmentTraceability,
} from "../../SERVICES/tools/shipmentTraceability";
import BeerLoader from "../general/Loading";
import "./ShipmentTraceabilityReport.css";

function shipmentDate(shipment: Shipment): string {
    const date = shipment.createdAt?.toDate?.();
    return date ? date.toLocaleDateString("he-IL") : "תאריך לא ידוע";
}

function unit(row: ShipmentLotRow): string {
    return row.itemType === "kegs" ? "חביות" : row.itemType === "crates" ? "ארגזים" : "יח׳";
}

function escapeCsv(value: string | number): string {
    return '"' + String(value).replace(/"/g, '""') + '"';
}

export default function ShipmentTraceabilityReport() {
    const [shipments, setShipments] = useState<Shipment[]>([]);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState("");
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState("");
    const [details, setDetails] = useState<ShipmentTraceability | null>(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [detailsError, setDetailsError] = useState("");

    useEffect(() => onSnapshot(
        collection(db, "shipments"),
        (snapshot) => {
            setShipments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Shipment))
                .sort((a, b) => Number(b.shipmentNumber) - Number(a.shipmentNumber)));
            setLoading(false);
            setListError("");
        },
        (error) => {
            console.error("Unable to load shipment traceability report", error);
            setListError("לא ניתן לטעון תעודות משלוח. בדוק הרשאות וחיבור לרשת.");
            setLoading(false);
        },
    ), []);

    const selected = useMemo(
        () => shipments.find((shipment) => shipment.id === selectedId) ?? null,
        [selectedId, shipments],
    );
    const visible = useMemo(() => {
        const query = search.trim().toLocaleLowerCase("he-IL");
        if (!query) return shipments;
        return shipments.filter((shipment) =>
            String(shipment.shipmentNumber ?? shipment.id).includes(query) ||
            String(shipment.customerName ?? "").toLocaleLowerCase("he-IL").includes(query)
        );
    }, [search, shipments]);

    useEffect(() => {
        let cancelled = false;
        setDetails(null);
        setDetailsError("");
        if (!selected) {
            setDetailsLoading(false);
            return () => { cancelled = true; };
        }

        async function load() {
            setDetailsLoading(true);
            try {
                // Only fetch pallets for a selected historical note. New notes
                // use the immutable snapshot embedded in the shipment.
                const palletIds = selected?.palletSnapshot !== undefined ||
                    selected?.sourceType === "manual" ||
                    (selected?.manualLines?.length ?? 0) > 0
                    ? [] : [...new Set(selected?.palletIds ?? [])];
                const snapshots = await Promise.all(
                    palletIds.map((id) => getDoc(doc(db, "pallets", id))),
                );
                if (cancelled || !selected) return;
                const pallets: Pallet[] = snapshots.filter((snap) => snap.exists())
                    .map((snap) => ({ id: snap.id, ...snap.data() } as Pallet));
                setDetails(buildShipmentTraceability(selected, pallets, getCatalogEntry));
            } catch (error) {
                console.error("Unable to load shipment lots", error);
                if (!cancelled) setDetailsError("לא ניתן לטעון את פירוט האצוות של התעודה. אין להסתמך על דוח חלקי.");
            } finally {
                if (!cancelled) setDetailsLoading(false);
            }
        }
        void load();
        return () => { cancelled = true; };
    }, [selected]);

    const groups = useMemo(() => {
        const grouped = new Map<string, { sku: string; description: string; itemType: ShipmentLotRow["itemType"]; rows: ShipmentLotRow[]; total: number }>();
        for (const row of details?.rows ?? []) {
            const key = JSON.stringify([row.sku, row.description, row.itemType]);
            const existing = grouped.get(key);
            if (existing) {
                existing.total += row.quantity;
                existing.rows.push(row);
            } else {
                grouped.set(key, {
                    sku: row.sku,
                    description: row.description,
                    itemType: row.itemType,
                    rows: [row],
                    total: row.quantity,
                });
            }
        }
        return [...grouped.values()];
    }, [details]);

    function downloadCsv() {
        if (!selected || !details || detailsLoading || detailsError) return;
        const data: Array<Array<string | number>> = [
            ["תעודת משלוח", "תאריך", "לקוח", "מק״ט", "פריט", "אצווה", "כמות", "יחידה", "תפוגה", "סטטוס מקור"],
        ];
        details.rows.forEach((row) => data.push([
            selected.shipmentNumber, shipmentDate(selected), selected.customerName ?? "",
            row.sku, row.description, row.batchNumber ?? "לא ידוע",
            row.quantity, unit(row), displayShipmentExpiry(row.expiryDateStr),
            row.unverified ? "חסר מידע" : "מזוהה",
        ]));
        const csv = "\uFEFF" + data.map((line) => line.map(escapeCsv).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "shipment-lots-" + selected.shipmentNumber + ".csv";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return (
        <section dir="rtl" className="shipment-traceability">
            <header className="shipment-traceability-heading">
                <div>
                    <h2>דוח משלוחים – עקיבות אצוות</h2>
                    <p>לשימוש פנימי בלבד: פירוט מק״טים, אצוות, כמויות ותאריכי תפוגה.</p>
                </div>
                <span>{shipments.length} תעודות במערכת</span>
            </header>

            <div className="shipment-traceability-picker">
                <label>
                    <span>איתור תעודה או לקוח</span>
                    <span className="shipment-traceability-search">
                        <Search size={17} aria-hidden="true" />
                        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="מספר תעודה או שם לקוח" />
                    </span>
                </label>
                <label>
                    <span>תעודת משלוח</span>
                    <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                        <option value="">בחר תעודה</option>
                        {selectedId && !visible.some((s) => s.id === selectedId) && selected && (
                            <option value={selected.id}>{selected.shipmentNumber} · {selected.customerName || "ללא לקוח"}</option>
                        )}
                        {visible.map((shipment) => (
                            <option key={shipment.id} value={shipment.id}>
                                {shipment.shipmentNumber} · {shipmentDate(shipment)} · {shipment.customerName || "ללא לקוח"}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {loading && <BeerLoader message="טוען תעודות..." size="small" />}
            {listError && <p role="alert" className="shipment-traceability-warning">{listError}</p>}
            {!loading && !listError && visible.length === 0 && <p>אין תעודות מתאימות.</p>}

            {selected && <>
                <div className="shipment-traceability-heading shipment-traceability-details">
                    <div>
                        <h3>תעודת משלוח {selected.shipmentNumber}</h3>
                        <p>{shipmentDate(selected)} · {selected.customerName || "ללא שם לקוח"}</p>
                    </div>
                    <button type="button" className="status-filter-button" onClick={downloadCsv}
                        disabled={!details || detailsLoading || Boolean(detailsError) || !details.rows.length}>
                        <Download size={17} aria-hidden="true" /> ייצוא CSV
                    </button>
                </div>
                {detailsLoading && <BeerLoader message="טוען אצוות ותפוגות..." size="small" />}
                {detailsError && <p role="alert" className="shipment-traceability-warning">{detailsError}</p>}
                {details && !detailsLoading && !detailsError && <>
                    {details.warnings.map((warning, i) =>
                        <p role="status" className="shipment-traceability-warning" key={i}>{warning}</p>
                    )}
                    {selected.palletSnapshot === undefined && (selected.palletIds?.length ?? 0) > 0 &&
                        <p className="shipment-traceability-warning">
                            תעודה היסטורית: הפרטים שוחזרו מנתוני המשטחים הנוכחיים. ייתכן ששונו מאז המשלוח.
                        </p>}
                    {groups.length === 0 ? <p>לא נמצאו פריטים בתעודה.</p> : groups.map((group) => (
                        <div className="shipment-traceability-group" key={JSON.stringify([group.sku, group.description, group.itemType])}>
                            <div className="shipment-traceability-group-title">
                                <div><strong>{group.sku}</strong> · {group.description}</div>
                                <span>סה״כ {group.total} {unit(group.rows[0])}</span>
                            </div>
                            <div className="shipment-traceability-scroll">
                                <table>
                                    <thead><tr><th>אצווה</th><th>כמות</th><th>תאריך תפוגה</th><th>מצב נתונים</th></tr></thead>
                                    <tbody>{group.rows.map((row, i) => (
                                        <tr key={i}>
                                            <td>{row.batchNumber || "לא ידוע"}</td>
                                            <td>{row.quantity} {unit(row)}</td>
                                            <td>{displayShipmentExpiry(row.expiryDateStr)}</td>
                                            <td>{row.unverified ? "חסר מידע" : "זוהה"}</td>
                                        </tr>
                                    ))}</tbody>
                                </table>
                            </div>
                        </div>
                    ))}
                </>}
            </>}
        </section>
    );
}
