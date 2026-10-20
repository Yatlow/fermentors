import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocsFromServer, onSnapshot, query, where } from "firebase/firestore";
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
import { buildBatchTraceability, listTraceableBatches, type PackagingActualRecord, type BatchSkuSummary } from "../../SERVICES/tools/batchTraceability";
import BeerLoader from "../general/Loading";
import "./ShipmentTraceabilityReport.css";

function shipmentDate(shipment: Shipment): string {
    const date = shipment.createdAt?.toDate?.();
    return date ? date.toLocaleDateString("he-IL") : "תאריך לא ידוע";
}

function unit(row: { itemType: ShipmentLotRow["itemType"] }): string {
    return row.itemType === "kegs" ? "חביות" : row.itemType === "crates" ? "ארגזים" : "יח׳";
}

function escapeCsv(value: string | number): string {
    return '"' + String(value).replace(/"/g, '""') + '"';
}

export default function ShipmentTraceabilityReport() {
    const [shipments, setShipments] = useState<Shipment[]>([]);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState("");
    const [mode, setMode] = useState<"shipment" | "batch">("shipment");
    const [batchNumber, setBatchNumber] = useState("");
    const [pallets, setPallets] = useState<Pallet[]>([]);
    const [palletsLoading, setPalletsLoading] = useState(false);
    const [palletsError, setPalletsError] = useState("");
    const [palletsReady, setPalletsReady] = useState(false);
    const [packagingActuals, setPackagingActuals] = useState<PackagingActualRecord[] | null>(null);
    const [packagingBatchLoaded, setPackagingBatchLoaded] = useState("");
    const [packagingLoading, setPackagingLoading] = useState(false);
    const [packagingError, setPackagingError] = useState("");
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

    // Batch view is intentionally lazy: scan pallets only when the user opens it.
    // No backfill, writes, or second inventory snapshot is created.
    useEffect(() => {
        if (mode !== "batch") return;
        let cancelled = false;
        setPalletsLoading(true);
        setPalletsError("");
        getDocsFromServer(collection(db, "pallets"))
            .then((snapshot) => {
                if (cancelled) return;
                setPallets(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Pallet)));
                setPalletsReady(true);
            })
            .catch((error) => {
                console.error("Unable to load batch pallet index", error);
                if (!cancelled) {
                    setPalletsReady(false);
                    setPalletsError("לא ניתן לטעון את אינדקס המשטחים. אין להסתמך על מלאי חלקי.");
                }
            })
            .finally(() => { if (!cancelled) setPalletsLoading(false); });
        return () => { cancelled = true; };
    }, [mode]);

    // Fetch actual packaging reports for the selected batch only.
    // packagingLog.quantity is stored in kegs or complete 24-bottle crates.
    useEffect(() => {
        if (mode !== "batch" || !batchNumber.trim()) {
            setPackagingActuals(null);
            setPackagingBatchLoaded("");
            setPackagingLoading(false);
            setPackagingError("");
            return;
        }
        let cancelled = false;
        setPackagingActuals(null);
        setPackagingBatchLoaded("");
        setPackagingLoading(true);
        setPackagingError("");
        const timer = window.setTimeout(async () => {
            try {
                const batch = batchNumber.trim().replace(/^#/, "");
                const alternatives: Array<string | number> = [batch, "#" + batch];
                const numeric = Number(batch);
                if (/^\d+$/.test(batch) && Number.isSafeInteger(numeric)) alternatives.push(numeric);
                // Single-field query, no composite index or full-history scan.
                const snapshot = await getDocsFromServer(query(
                    collection(db, "packagingLog"), where("batchNumber", "in", alternatives),
                ));
                if (cancelled) return;
                setPackagingActuals(snapshot.docs.map((item) => ({
                    id: item.id, ...item.data(),
                } as PackagingActualRecord)));
                setPackagingBatchLoaded(batchNumber);
            } catch (error) {
                console.error("Unable to load actual packaging reports for traceability", error);
                if (!cancelled) setPackagingError("לא ניתן לטעון דיווחי אריזה בפועל. לא ניתן לבצע בקרת התאמה מהימנה.");
            } finally {
                if (!cancelled) setPackagingLoading(false);
            }
        }, 200);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [batchNumber, mode]);

    const batches = useMemo(() => listTraceableBatches(shipments, pallets), [shipments, pallets]);
    const batchDetail = useMemo(
        () => mode === "batch" && palletsReady && !palletsLoading && !palletsError &&
            !packagingLoading && !packagingError && packagingBatchLoaded === batchNumber &&
            !loading && !listError && batchNumber.trim()
            ? buildBatchTraceability(batchNumber.trim(), shipments, pallets, getCatalogEntry, packagingActuals) : null,
        [mode, palletsReady, palletsLoading, palletsError, packagingLoading, packagingError, packagingBatchLoaded, packagingActuals, loading, listError, batchNumber, shipments, pallets],
    );

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

    function reconciliationLabel(item: BatchSkuSummary): string {
        if (item.reconciliationStatus === "unknown") return "לא ניתן לאמת";
        if (item.reconciliationStatus === "matched") return "תואם";
        if (item.reconciliationStatus === "shortage") return "חוסר בלתי מוסבר";
        return "עודף בלתי מוסבר";
    }

    function varianceLabel(item: BatchSkuSummary): string {
        if (item.variance === null) return "לא ידוע";
        if (item.variance === 0) return "0";
        return (item.variance > 0 ? "חסרות " : "עודף ") +
            Math.abs(item.variance) + " " + unit(item);
    }

    function downloadBatchCsv() {
        if (!batchDetail) return;
        const data: Array<Array<string | number>> = [
            ["אצווה", "תעודת משלוח", "תאריך", "לקוח", "מק״ט", "פריט", "כמות שנשלחה", "יחידה", "תפוגה", "אימות"],
        ];
        batchDetail.shipments.forEach((row) => data.push([
            batchNumber, row.shipmentNumber, row.shipmentDate?.toLocaleDateString("he-IL") ?? "לא ידוע",
            row.customerName, row.sku, row.description, row.quantity, unit(row),
            displayShipmentExpiry(row.expiryDateStr), row.unverified ? "חסר מידע" : "מזוהה",
        ]));
        data.push([]);
        data.push(["אצווה", "מק״ט", "פריט", "נארז בפועל", "נשלח", "נותר", "פער", "סטטוס התאמה", "יחידה"]);
        batchDetail.summaries.forEach((row) => data.push([
            batchNumber, row.sku, row.description, row.packaged ?? "לא ידוע",
            row.shipped, row.remaining, row.variance ?? "לא ידוע",
            reconciliationLabel(row), unit(row),
        ]));
        data.push([]);
        data.push(["אצווה", "מק״ט", "פריט", "כמות נותרת", "יחידה", "תפוגה", "מיקום"]);
        batchDetail.stock.forEach((row) => data.push([
            batchNumber, row.sku, row.description, row.quantity, unit(row),
            displayShipmentExpiry(row.expiryDateStr),
            Object.entries(row.zones).map(([zone, qty]) => zone + ": " + qty).join("; "),
        ]));
        const csv = "\uFEFF" + data.map((line) => line.map(escapeCsv).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "batch-traceability-" + batchNumber + ".csv";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const stockZoneNames: Record<string, string> = {
        cooler: "מקרר", pending: "ממתין לשיבוץ", bottleRoom: "חדר בקבוקים", loadingDock: "רציף טעינה",
    };

    return (
        <section dir="rtl" className="shipment-traceability">
            <header className="shipment-traceability-heading">
                <div>
                    <h2>דוח עקיבות</h2>
                    <p>לשימוש פנימי בלבד: תנועות לפי תעודת משלוח או אצווה, כמויות, לקוחות, מלאי ותפוגה.</p>
                </div>
                <span>{shipments.length} תעודות במערכת</span>
            </header>

            <div className="shipment-traceability-modes" role="group" aria-label="צורת הצגת דוח עקיבות">
                <button type="button" className={mode === "shipment" ? "active" : ""} aria-pressed={mode === "shipment"} onClick={() => setMode("shipment")}>לפי משלוח</button>
                <button type="button" className={mode === "batch" ? "active" : ""} aria-pressed={mode === "batch"} onClick={() => setMode("batch")}>לפי אצווה</button>
            </div>
            {mode === "shipment" && <>
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
                            הפרטים מוצגים על פי רשומות המשטחים המקושרות. שינוי בפרטי משטח ישפיע גם על דוח זה.
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
            </>}
            {mode === "batch" && <>
                <div className="shipment-traceability-picker">
                    <label>
                        <span>בחירת אצווה</span>
                        <input type="text" list="traceability-batches" value={batchNumber}
                            onChange={(event) => setBatchNumber(event.target.value)}
                            placeholder="מספר אצווה – בחר או הקלד"
                            disabled={palletsLoading || Boolean(palletsError) || loading || Boolean(listError)} />
                        <datalist id="traceability-batches">
                            {batches.map((batch) => <option key={batch} value={batch} />)}
                        </datalist>
                    </label>
                    {batchDetail && <button type="button" className="status-filter-button" onClick={downloadBatchCsv}>
                        <Download size={17} aria-hidden="true" /> ייצוא CSV
                    </button>}
                </div>
                {palletsLoading && <BeerLoader message="טוען אינדקס משטחים ואצוות..." size="small" />}
                {packagingLoading && <BeerLoader message="מצליב דיווחי אריזה..." size="small" />}
                {packagingError && <p role="alert" className="shipment-traceability-warning">{packagingError}</p>}
                {palletsError && <p role="alert" className="shipment-traceability-warning">{palletsError}</p>}
                {listError && <p role="alert" className="shipment-traceability-warning">{listError}</p>}
                {!palletsLoading && palletsReady && !palletsError && !loading && batches.length === 0 && <p>לא נמצאו אצוות עם נתוני משטחים.</p>}
                {batchDetail && <>
                    <div className="shipment-traceability-heading shipment-traceability-details">
                        <div>
                            <h3>עקיבות אצווה {batchDetail.batchNumber}</h3>
                            <p>נארז מתוך דיווחי אריזה בפועל · נשלח מתוך תעודות · יתרה מתוך משטחים פעילים.</p>
                        </div>
                    </div>
                    {batchDetail.hasUnverifiedShipments && <p className="shipment-traceability-warning">
                        בחלק מהמשלוחים חסרים פרטי אצווה או תפוגה; הפרטים החסרים מסומנים בטבלה.
                    </p>}
                    {batchDetail.missingHistoricalPallets > 0 && <p className="shipment-traceability-warning">
                        נמצאו {batchDetail.missingHistoricalPallets} הפניות למשטחים היסטוריים חסרים במערכת; ייתכן שיש משלוחים שאי אפשר לשייך לאצווה.
                    </p>}
                    {batchDetail.invalidPackagingRecords > 0 && <p role="alert" className="shipment-traceability-warning">
                        {batchDetail.invalidPackagingRecords} דיווחי אריזה מכילים כמות, סוג פריט או סגנון לא תקינים; אין להתייחס להתאמה כחיובית בלי בדיקתם.
                    </p>}
                    {batchDetail.summaries.some((row) => row.reconciliationStatus === "shortage") &&
                        <p role="alert" className="shipment-traceability-warning">
                            קיימים פערי מלאי בלתי מוסברים: כמות האריזה גבוהה מסכום המשלוחים המזוהים והמלאי הקיים.
                            ייתכן שמדובר ביציאה לא מתועדת או בדיווח חסר; אין לייחס את הפער למשלוח מסוים ללא נתונים.
                        </p>}
                    {batchDetail.summaries.some((row) => row.reconciliationStatus === "excess") &&
                        <p role="alert" className="shipment-traceability-warning">
                            קיימים עודפים: כמות המשלוחים והמלאי יחד גדולה מכמות האריזה המדווחת.
                        </p>}
                    {batchDetail.summaries.some((row) => row.reconciliationStatus === "unknown") &&
                        <p className="shipment-traceability-warning">
                            אין דיווחי אריזה תקפים לחלק מהמק״טים. בדיקת ההתאמה שלהם אינה זמינה ולא תיחשב תקינה.
                        </p>}
                    {batchDetail.summaries.length === 0
                        ? <p>אין משלוחים או מלאי משטחים מזוהים לאצווה זו.</p>
                        : <div className="shipment-traceability-group">
                            <div className="shipment-traceability-group-title"><strong>סיכום לפי מק״ט</strong></div>
                            <div className="shipment-traceability-scroll"><table>
                                <thead><tr><th>מק״ט / פריט</th><th>נארז בפועל</th><th>נשלח</th><th>נותר אצלנו</th><th>פער</th><th>בדיקת התאמה</th></tr></thead>
                                <tbody>{batchDetail.summaries.map((row) => (
                                    <tr key={JSON.stringify([row.sku, row.itemType])}>
                                        <td><strong>{row.sku}</strong> · {row.description}</td>
                                        <td>{row.packaged === null ? "לא ידוע" : row.packaged + " " + unit(row)}</td>
                                        <td>{row.shipped} {unit(row)}</td>
                                        <td>{row.remaining} {unit(row)}</td>
                                        <td>{varianceLabel(row)}</td>
                                        <td><span className={"traceability-result traceability-result--" + row.reconciliationStatus}>
                                            {reconciliationLabel(row)}
                                        </span></td>
                                    </tr>
                                ))}</tbody>
                            </table></div>
                        </div>}
                    <div className="shipment-traceability-group">
                        <div className="shipment-traceability-group-title"><strong>היסטוריית משלוחים</strong><span>{batchDetail.shipments.length} שורות משלוח</span></div>
                        <div className="shipment-traceability-scroll"><table>
                            <thead><tr><th>תאריך</th><th>תעודה</th><th>לקוח</th><th>מק״ט / פריט</th><th>כמות</th><th>תפוגה</th><th>מקור נתונים</th></tr></thead>
                            <tbody>{batchDetail.shipments.length ? batchDetail.shipments.map((row, index) => (
                                <tr key={row.shipmentId + "-" + index}>
                                    <td>{row.shipmentDate?.toLocaleDateString("he-IL") ?? "לא ידוע"}</td>
                                    <td>{row.shipmentNumber}</td>
                                    <td>{row.customerName}</td>
                                    <td>{row.sku} · {row.description}</td>
                                    <td>{row.quantity} {unit(row)}</td>
                                    <td>{displayShipmentExpiry(row.expiryDateStr)}</td>
                                    <td>{row.unverified ? "חסר מידע" : "מזוהה"}</td>
                                </tr>
                            )) : <tr><td colSpan={7}>לא נמצאו משלוחים מזוהים לאצווה זו.</td></tr>}</tbody>
                        </table></div>
                    </div>
                    <div className="shipment-traceability-group">
                        <div className="shipment-traceability-group-title"><strong>מלאי שנותר אצלנו</strong><span>משטחים שלא נשלחו</span></div>
                        <div className="shipment-traceability-scroll"><table>
                            <thead><tr><th>מק״ט / פריט</th><th>כמות</th><th>תפוגה</th><th>מיקום</th></tr></thead>
                            <tbody>{batchDetail.stock.length ? batchDetail.stock.map((row, index) => (
                                <tr key={index}>
                                    <td>{row.sku} · {row.description}</td>
                                    <td>{row.quantity} {unit(row)}</td>
                                    <td>{displayShipmentExpiry(row.expiryDateStr)}</td>
                                    <td>{Object.entries(row.zones).map(([zone, qty]) => (stockZoneNames[zone] || zone) + ": " + qty).join(" · ")}</td>
                                </tr>
                            )) : <tr><td colSpan={4}>אין משטחים פעילים לאצווה זו במלאי.</td></tr>}</tbody>
                        </table></div>
                    </div>
                </>}
            </>}
        </section>
    );
}
