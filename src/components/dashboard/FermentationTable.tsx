import { useEffect, useRef, useState, type CSSProperties, type TouchEvent } from "react";
import type { Measurement } from "../../SERVICES/cellering/calculateCelleringRecomendations";
import "./FermentationTable.css";

type Props = {
    measurements: Measurement[];
};

const MIN_ZOOM = 30;
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

function touchDistance(event: TouchEvent<HTMLDivElement>): number {
    if (event.touches.length < 2) return 0;
    const [a, b] = [event.touches[0], event.touches[1]];
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

export default function FermentationTable({ measurements }: Props) {
    const rows = [...measurements].sort((a, b) =>
        String(b.id ?? "").localeCompare(String(a.id ?? ""))
    );

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const tableRef = useRef<HTMLTableElement | null>(null);
    const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
    const [zoom, setZoom] = useState(100);
    const [isFitted, setIsFitted] = useState(false);

    function clampZoom(value: number): number {
        return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    }

    function fitToWidth() {
        const viewport = scrollRef.current;
        const table = tableRef.current;
        if (!viewport || !table) return;

        // getBoundingClientRect() includes CSS zoom. Divide by the current
        // scale to recover the table's actual 100% width. scrollWidth does not
        // behave consistently with CSS zoom on iOS Safari and was causing the
        // old fit calculation to hit the minimum zoom too early.
        const currentScale = zoom / 100;
        const renderedWidth = table.getBoundingClientRect().width;
        const naturalWidth = renderedWidth / Math.max(currentScale, 0.01);
        if (!naturalWidth) return;

        // Keep a tiny safety margin so the last column/border is never clipped.
        const availableWidth = Math.max(0, viewport.clientWidth - 4);
        const nextZoom = Math.floor((availableWidth / naturalWidth) * 100 * 0.99);
        setZoom(clampZoom(Math.min(100, nextZoom)));
        setIsFitted(true);
        viewport.scrollLeft = 0;
    }

    function changeZoom(nextZoom: number) {
        setZoom(clampZoom(nextZoom));
        setIsFitted(false);
    }

    function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
        if (event.touches.length !== 2) return;
        pinchRef.current = {
            distance: touchDistance(event),
            zoom,
        };
        setIsFitted(false);
    }

    function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
        if (event.touches.length !== 2 || !pinchRef.current) return;
        const distance = touchDistance(event);
        if (!distance || !pinchRef.current.distance) return;

        event.preventDefault();
        const ratio = distance / pinchRef.current.distance;
        const nextZoom = Math.round(pinchRef.current.zoom * ratio);
        setZoom(clampZoom(nextZoom));
    }

    function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
        if (event.touches.length < 2) {
            pinchRef.current = null;
        }
    }

    useEffect(() => {
        const viewport = scrollRef.current;
        if (!viewport || typeof ResizeObserver === "undefined") return;

        const observer = new ResizeObserver(() => {
            // Only recompute automatically when the user explicitly chose
            // "fit to screen". Manual zoom and pinch remain untouched.
            if (isFitted) fitToWidth();
        });
        observer.observe(viewport);
        return () => observer.disconnect();
        // fitToWidth intentionally reads the latest rendered width/zoom.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFitted, zoom]);

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
                            onClick={() => changeZoom(zoom - ZOOM_STEP)}
                            disabled={zoom <= MIN_ZOOM}
                            aria-label="הקטן טבלה"
                        >
                            −
                        </button>
                        <button
                            type="button"
                            className="fermentation-zoom-value"
                            onClick={() => changeZoom(100)}
                            title="חזרה ל-100%"
                        >
                            {zoom}%
                        </button>
                        <button
                            type="button"
                            className="fermentation-zoom-button"
                            onClick={() => changeZoom(zoom + ZOOM_STEP)}
                            disabled={zoom >= MAX_ZOOM}
                            aria-label="הגדל טבלה"
                        >
                            +
                        </button>
                        <button
                            type="button"
                            className={`fermentation-fit-button ${isFitted ? "active" : ""}`}
                            onClick={fitToWidth}
                        >
                            התאם למסך
                        </button>
                    </div>
                    <span className="fermentation-row-count">{rows.length} רשומות</span>
                </div>
            </div>

            <div
                className="fermentation-table-scroll"
                ref={scrollRef}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
            >
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
