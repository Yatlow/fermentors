import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Measurement } from "../../SERVICES/cellering/calculateCelleringRecomendations";
import "./FermentationTable.css";

type Props = {
    measurements: Measurement[];
};

const MIN_ZOOM = 45;
const MAX_ZOOM = 120;
const ZOOM_STEP = 10;

function formatDate(measurement: Measurement): string {
    const rawDate = (measurement as Measurement & { date?: unknown }).date;
    if (rawDate) return String(rawDate);

    const match = String(measurement.id ?? "").match(/^(\d{4})-(\d{2})-(\d{2})_/);
    if (!match) return "—";
    const [, year, month, day] = match;
    return `${day}/${month}/${year}`;
}

function formatTime(measurement: Measurement): string {
    const rawTime = (measurement as Measurement & { time?: unknown }).time;
    if (rawTime) return String(rawTime);

    const match = String(measurement.id ?? "").match(/_(\d{2})(\d{2})$/);
    if (!match) return "—";
    return `${match[1]}:${match[2]}`;
}

function displayValue(value: unknown, suffix = ""): string {
    if (value === null || value === undefined || value === "") return "—";
    return `${value}${suffix}`;
}

function rowEventClass(notes: string): string {
    if (!notes) return "";
    if (notes.includes("שמרים") || notes.includes("הורדת")) return " fermentation-row-yeast";
    if (notes.includes("דרייהופ") || notes.includes("הכנסת כשות")) return " fermentation-row-dryhop";
    if (notes.includes("מנוחת") || notes.includes("דיאציטיל") || notes.includes("חימום")) return " fermentation-row-diacetyl";
    if (notes.includes("סגירת") || notes.includes("סגירה")) return " fermentation-row-pressure";
    if (notes.includes("קירור")) return " fermentation-row-cooling";
    return "";
}

export default function FermentationTable({ measurements }: Props) {
    const rows = [...measurements].sort((a, b) =>
        String(b.id ?? "").localeCompare(String(a.id ?? ""))
    );

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const tableRef = useRef<HTMLTableElement | null>(null);
    const [zoom, setZoom] = useState(100);

    function fitToWidth() {
        const viewport = scrollRef.current;
        const table = tableRef.current;
        if (!viewport || !table) return;

        // scrollWidth is measured at the current zoom. Convert it back to the
        // table's approximate 100% width, then calculate the scale needed to fit.
        const currentScale = zoom / 100;
        const naturalWidth = table.scrollWidth / Math.max(currentScale, 0.01);
        if (!naturalWidth) return;

        const nextZoom = Math.floor((viewport.clientWidth / naturalWidth) * 100);
        setZoom(Math.max(MIN_ZOOM, Math.min(100, nextZoom)));
        viewport.scrollLeft = 0;
    }

    useEffect(() => {
        const viewport = scrollRef.current;
        if (!viewport || typeof ResizeObserver === "undefined") return;

        const observer = new ResizeObserver(() => {
            // Keep a fitted table fitted when the modal/orientation changes,
            // without overriding a user's manually selected zoom level.
            if (zoom < 100) fitToWidth();
        });
        observer.observe(viewport);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [zoom]);

    if (rows.length === 0) {
        return <div className="batch-chart-status">אין עדיין מדידות לאצווה זו</div>;
    }

    const tableStyle = {
        zoom: `${zoom}%`,
    } as CSSProperties & { zoom: string };

    return (
        <div className="fermentation-table-card" dir="rtl">
            <div className="fermentation-table-heading">
                <div>
                    <strong>טבלת תסיסה</strong>
                    <span>המדידות והפעולות כפי שנשמרו במהלך האצווה</span>
                </div>

                <div className="fermentation-table-heading-actions">
                    <div className="fermentation-zoom-controls" aria-label="זום טבלת תסיסה">
                        <button
                            type="button"
                            className="fermentation-zoom-button"
                            onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
                            disabled={zoom <= MIN_ZOOM}
                            aria-label="הקטן טבלה"
                        >
                            −
                        </button>
                        <button
                            type="button"
                            className="fermentation-zoom-value"
                            onClick={() => setZoom(100)}
                            title="חזרה ל-100%"
                        >
                            {zoom}%
                        </button>
                        <button
                            type="button"
                            className="fermentation-zoom-button"
                            onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
                            disabled={zoom >= MAX_ZOOM}
                            aria-label="הגדל טבלה"
                        >
                            +
                        </button>
                        <button
                            type="button"
                            className="fermentation-fit-button"
                            onClick={fitToWidth}
                        >
                            התאם למסך
                        </button>
                    </div>
                    <span className="fermentation-row-count">{rows.length} רשומות</span>
                </div>
            </div>

            <div className="fermentation-table-scroll" ref={scrollRef}>
                <table className="fermentation-table" ref={tableRef} style={tableStyle}>
                    <thead>
                        <tr>
                            <th>תאריך</th>
                            <th>שעה</th>
                            <th className="metric-plato">סוכר</th>
                            <th className="metric-temp">טמפ׳</th>
                            <th className="metric-pressure">לחץ</th>
                            <th className="metric-ph">pH</th>
                            <th className="metric-carb">גיזוז</th>
                            <th className="notes-column">פעולה / הערה</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((measurement, index) => {
                            const notes = String(measurement.notes ?? "").trim();
                            const carbonation = (measurement as Measurement & { carbonation?: unknown }).carbonation;

                            return (
                                <tr
                                    key={String(measurement.id ?? index)}
                                    className={rowEventClass(notes)}
                                >
                                    <td className="date-cell">{formatDate(measurement)}</td>
                                    <td className="time-cell">{formatTime(measurement)}</td>
                                    <td className="metric-cell metric-plato">{displayValue(measurement.plato, "°P")}</td>
                                    <td className="metric-cell metric-temp">{displayValue(measurement.temp, "°C")}</td>
                                    <td className="metric-cell metric-pressure">{displayValue(measurement.pressure, " bar")}</td>
                                    <td className="metric-cell metric-ph">{displayValue(measurement.pH)}</td>
                                    <td className="metric-cell metric-carb">{displayValue(carbonation)}</td>
                                    <td className="notes-cell">{notes || "—"}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
