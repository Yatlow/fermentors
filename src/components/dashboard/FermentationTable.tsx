import type { Measurement } from "../../SERVICES/cellering/calculateCelleringRecomendations";
import "./FermentationTable.css";

type Props = {
    measurements: Measurement[];
};

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

    if (rows.length === 0) {
        return <div className="batch-chart-status">אין עדיין מדידות לאצווה זו</div>;
    }

    return (
        <div className="fermentation-table-card" dir="rtl">
            <div className="fermentation-table-heading">
                <div>
                    <strong>טבלת תסיסה</strong>
                    <span>המדידות והפעולות כפי שנשמרו במהלך האצווה</span>
                </div>
                <span className="fermentation-row-count">{rows.length} רשומות</span>
            </div>

            <div className="fermentation-table-scroll">
                <table className="fermentation-table">
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
