// components/BatchReportsView.tsx

import { useEffect, useMemo, useState } from "react";

import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Brush,
    AreaChart,
    Area,
} from "recharts";

import type { TooltipContentProps } from "recharts";

import {
    getAllBrewsSummary,
    type BrewSummary,
} from "../SERVICES/getAllBrews";

import {
    getMeasurementsByBatch,
} from "../SERVICES/gettAllDataByBatch";

import {
    getStyleAverages,
    getAllStyleAverageStyles,
    type StyleAverages,
    type StyleAverageDay,
} from "../SERVICES/getStyleAverages";

import { parseYeastDropAmount } from "../SERVICES/calculateCelleringRecomendations";

import type { Fermentor } from "../App";


// ============================================================
// TYPES
// ============================================================

type Measurement = {
    id: string;
    date: string;

    temp?: number | null;
    plato?: number | null;
    pH?: number | null;
    pressure?: number | null;
    carbonation?: number | null;

    notes?: string | null;
};


type MetricKey =
    | "temp"
    | "plato"
    | "pH"
    | "pressure"
    | "carbonation";


type MetricDefinition = {
    key: MetricKey;
    label: string;
    color: string;
};


type ChartPoint = {
    day: number;
    current?: number | null;
    average?: number | null;
};

// תצוגת הדוח: אצוות שכרגע במיכל / אצוות ישנות / ממוצעים בלבד (ללא השוואה)
type ReportView = "current" | "old" | "averages";

type BatchReportsViewProps = {
    // ה-fermentors הפעילים כרגע (מגיע מ-App), משמש לזיהוי אילו batchNumber "במיכל"
    currentFermentors: Fermentor[];
};


// ============================================================
// METRICS
// צבעים עקביים עם BatchHistoryChart.tsx כדי שאותו מדד ייראה
// אותו דבר בכל הרכיבים באפליקציה.
// ============================================================

const METRICS: MetricDefinition[] = [
    { key: "temp", label: "טמפ׳", color: "#e0563f" },
    { key: "plato", label: "סוכר", color: "#d99323" },
    { key: "pH", label: "pH", color: "#5b8def" },
    { key: "pressure", label: "לחץ", color: "#3fa796" },
    { key: "carbonation", label: "גיזוז", color: "#0891b2" },
];

const REPORT_VIEWS: { key: ReportView; label: string }[] = [
    { key: "current", label: "באצ'ים שעכשיו במיכל" },
    { key: "old", label: "באצ'ים ישנים" },
    { key: "averages", label: "ממוצעים בלבד" },
];

// אצוות ישנות מזה לא רלוונטיות יותר להצגה
const MIN_OLD_BATCH_NUMBER = 1325;


// ============================================================
// DATE HELPERS
// ============================================================

function parseDate(value: string): Date | null {
    if (!value) return null;
    const str = String(value).trim();
    const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;

    const result = new Date(year, month - 1, day);

    if (
        result.getFullYear() !== year ||
        result.getMonth() !== month - 1 ||
        result.getDate() !== day
    ) {
        return null;
    }

    return result;
}


function getDayFromBrew(
    brewDateString: string,
    measurementDateString: string
): number | null {

    const brewDate = parseDate(brewDateString);
    const measurementDate = parseDate(measurementDateString);

    if (!brewDate || !measurementDate) return null;

    const start = new Date(brewDate.getFullYear(), brewDate.getMonth(), brewDate.getDate());
    const end = new Date(measurementDate.getFullYear(), measurementDate.getMonth(), measurementDate.getDate());

    return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}


// ============================================================
// AXIS HELPERS
// ============================================================

// טווח X הדוק לנתונים בפועל, עם עד 5 טיקים מפוזרים (לא רק מינימום/מקסימום)
function getXAxisBounds(
    days: number[]
): { domain: [number, number]; ticks: number[] } {

    const validDays = days.filter((d): d is number => Number.isFinite(d));

    if (validDays.length === 0) {
        return { domain: [0, 1], ticks: [0, 1] };
    }

    const min = Math.min(...validDays);
    const max = Math.max(...validDays);

    if (min === max) {
        return { domain: [min - 1, max + 1], ticks: [min] };
    }

    const tickCount = Math.min(5, max - min + 1);
    const step = (max - min) / (tickCount - 1);

    const ticks = Array.from(
        new Set(
            Array.from({ length: tickCount }, (_, i) =>
                Math.round(min + i * step)
            )
        )
    ).sort((a, b) => a - b);

    return { domain: [min, max], ticks };
}

// הימים הרלוונטיים לטווח ה-X של מדד ספציפי:
// - במצב current/old: רק הימים שבהם יש ערך אמיתי ל"אצווה הנוכחית" (לא הימים שקיימים רק בממוצע)
// - במצב averages: הימים שבהם יש ערך ל"ממוצע"
function getMetricDayRange(chartData: ChartPoint[], mode: ReportView): number[] {
    const field: "current" | "average" = mode === "averages" ? "average" : "current";

    return chartData
        .filter((p) => p[field] !== null && p[field] !== undefined)
        .map((p) => p.day);
}


// ============================================================
// YEAST DROPS (מבוסס על אותה לוגיקת פרסינג כמו BatchHistoryChart)
// ============================================================

type YeastChartPoint = {
    day: number;
    amount: number;
    note: string;
    type: "warm" | "cold";
    dateLabel: string;
};

function formatYeastTotal(amount: number): string {
    return String(Number(amount.toFixed(2)));
}

function formatMeasurementDateShort(dateString: string): string {
    const match = String(dateString).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!match) return dateString;
    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    return `${day}/${month}`;
}

function extractYeastDropsForBatch(
    measurements: Measurement[],
    brewDate: string
): YeastChartPoint[] {
    return measurements
        .map((measurement) => {
            const note = String(measurement.notes ?? "");
            if (!note.includes("שמרים") && !note.includes("שמרי")) return null;

            const amount = parseYeastDropAmount(note);
            if (amount === null) return null;

            const day = getDayFromBrew(brewDate, measurement.date);
            if (day === null) return null;

            const temp = measurement.temp;
            const type: "warm" | "cold" =
                temp !== null && temp !== undefined && Number.isFinite(temp) && temp <= 9
                    ? "cold"
                    : "warm";

            return {
                day,
                amount,
                note,
                type,
                dateLabel: formatMeasurementDateShort(measurement.date),
            };
        })
        .filter((d): d is YeastChartPoint => d !== null)
        .sort((a, b) => a.day - b.day);
}

type YeastCumulativePoint = { day: number; cumulative: number };

function buildYeastCumulativeData(drops: YeastChartPoint[]): YeastCumulativePoint[] {
    let running = 0;
    return drops.map((drop) => {
        running += drop.amount;
        return { day: drop.day, cumulative: Number(running.toFixed(2)) };
    });
}


// ============================================================
// TOOLTIP (מציג גם על כמה אצוות מבוסס הממוצע באותו יום)
// ============================================================

function makeAverageTooltipRenderer(
    styleAverages: StyleAverages | null
) {
    return function TooltipRenderer({ active, label, payload }: TooltipContentProps) {
        if (!active || !payload || payload.length === 0 || label === undefined) {
            return null;
        }

        const day = Number(label);
        const dayInfo = styleAverages?.days?.[String(day)] as StyleAverageDay | undefined;

        return (
            <div className="chart-tooltip">
                <div className="chart-tooltip-day">יום {day}</div>

                {payload.map((entry) => {
                    const isAverage = entry.dataKey === "average";
                    const value = entry.value;

                    return (
                        <div
                            key={String(entry.dataKey)}
                            className="chart-tooltip-value"
                            style={{ color: entry.color }}
                        >
                            {entry.name}: {value ?? "—"}
                            {isAverage && dayInfo?.batchCount
                                ? ` (מבוסס על ${dayInfo.batchCount} אצוות)`
                                : ""}
                        </div>
                    );
                })}
            </div>
        );
    };
}


// ============================================================
// COMPONENT
// ============================================================

export default function BatchReportsView({
    currentFermentors,
}: BatchReportsViewProps) {

    // ========================================================
    // STATE
    // ========================================================

    const [brews, setBrews] = useState<BrewSummary[]>([]);
    const [loadingBrews, setLoadingBrews] = useState(true);

    const [reportView, setReportView] = useState<ReportView>("current");

    const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
    const [selectedAverageStyle, setSelectedAverageStyle] = useState<string | null>(null);

    const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>(
        METRICS.map((m) => m.key)
    );

    const [dataByBatch, setDataByBatch] = useState<Record<string, Measurement[]>>({});
    const [styleAverages, setStyleAverages] = useState<StyleAverages | null>(null);
    const [loadingData, setLoadingData] = useState(false);

    const [availableStyles, setAvailableStyles] = useState<string[]>([]);
    const [loadingStyles, setLoadingStyles] = useState(true);

    useEffect(() => {
        getAllStyleAverageStyles()
            .then(setAvailableStyles)
            .catch((error) => {
                console.error("Failed loading style averages list:", error);
                setAvailableStyles([]);
            })
            .finally(() => setLoadingStyles(false));
    }, []);


    // ========================================================
    // LOAD BREWS
    // ========================================================

    useEffect(() => {
        getAllBrewsSummary()
            .then(setBrews)
            .finally(() => setLoadingBrews(false));
    }, []);


    // ========================================================
    // CURRENT (IN-TANK) BATCH NUMBERS
    // ========================================================

    const currentBatchNumbers = useMemo(() => {
        const set = new Set<string>();

        currentFermentors.forEach((tank) => {
            if (Number(tank.tankNumber) === 1) return;

            const batchNumber = tank.batchNumber;
            if (batchNumber === null || batchNumber === undefined || batchNumber === "") return;

            set.add(String(batchNumber));
        });

        return set;
    }, [currentFermentors]);


    // ========================================================
    // BREWS FILTERED BY REPORT VIEW (רק לתצוגות current/old)
    // ========================================================

    const selectableBrews = useMemo(() => {
        if (reportView === "averages") return [];

        return brews.filter((b) => {
            const isCurrent = currentBatchNumbers.has(String(b.batchNumber));
            const matchesView = reportView === "current" ? isCurrent : !isCurrent;

            if (!matchesView) return false;

            if (reportView === "old") {
                const batchNum = Number(b.batchNumber);
                if (Number.isFinite(batchNum) && batchNum < MIN_OLD_BATCH_NUMBER) {
                    return false;
                }
            }

            return true;
        });
    }, [brews, currentBatchNumbers, reportView]);


    function handleReportViewChange(view: ReportView) {
        setReportView(view);
        setSelectedBatchId(null);
        setSelectedAverageStyle(null);
    }


    // ========================================================
    // SELECTED STYLE
    // ========================================================

    const singleStyle = useMemo(() => {
        if (reportView === "averages") return selectedAverageStyle;

        if (!selectedBatchId) return null;

        const style = brews.find((b) => b.id === selectedBatchId)?.beerStyle;
        return style ? String(style) : null;
    }, [reportView, selectedAverageStyle, selectedBatchId, brews]);

    const hasSelection =
        reportView === "averages" ? !!selectedAverageStyle : !!selectedBatchId;


    // ========================================================
    // LOAD STYLE AVERAGE
    // ========================================================

    useEffect(() => {
        if (!singleStyle) {
            setStyleAverages(null);
            return;
        }

        let cancelled = false;

        getStyleAverages(singleStyle)
            .then((result) => {
                if (!cancelled) setStyleAverages(result);
            })
            .catch((error) => {
                console.error("Failed loading style averages:", error);
                if (!cancelled) setStyleAverages(null);
            });

        return () => {
            cancelled = true;
        };
    }, [singleStyle]);


    // ========================================================
    // LOAD MEASUREMENTS
    // ========================================================

    useEffect(() => {
        if (!selectedBatchId) {
            setDataByBatch({});
            return;
        }

        let cancelled = false;
        setLoadingData(true);

        getMeasurementsByBatch(selectedBatchId)
            .then((measurements) => {
                if (cancelled) return;
                setDataByBatch({ [selectedBatchId]: measurements as Measurement[] });
            })
            .catch((error) => {
                console.error("Failed loading measurements:", error);
            })
            .finally(() => {
                if (!cancelled) setLoadingData(false);
            });

        return () => {
            cancelled = true;
        };
    }, [selectedBatchId]);


    // ========================================================
    // CURRENT BATCH DATA
    // ========================================================

    const currentBatchChartData = useMemo(() => {
        if (!selectedBatchId) return [];

        const brew = brews.find((b) => b.id === selectedBatchId);
        if (!brew) return [];

        const measurements = dataByBatch[selectedBatchId] ?? [];

        return measurements
            .map((measurement) => {
                const day = getDayFromBrew(brew.brewDate, measurement.date);
                if (day === null) return null;

                return {
                    day,
                    temp: measurement.temp ?? null,
                    plato: measurement.plato ?? null,
                    pH: measurement.pH ?? null,
                    pressure: measurement.pressure ?? null,
                    carbonation: measurement.carbonation ?? null,
                };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .sort((a, b) => a.day - b.day);
    }, [selectedBatchId, brews, dataByBatch]);


    // ========================================================
    // YEAST DROPS FOR SELECTED BATCH
    // ========================================================

    const currentBatchYeastDrops = useMemo<YeastChartPoint[]>(() => {
        if (!selectedBatchId) return [];

        const brew = brews.find((b) => b.id === selectedBatchId);
        if (!brew) return [];

        const measurements = dataByBatch[selectedBatchId] ?? [];

        return extractYeastDropsForBatch(measurements, brew.brewDate);
    }, [selectedBatchId, brews, dataByBatch]);

    const yeastCumulativeData = useMemo(
        () => buildYeastCumulativeData(currentBatchYeastDrops),
        [currentBatchYeastDrops]
    );

    const yeastDropsByDay = useMemo(() => {
        const map = new Map<number, YeastChartPoint>();
        currentBatchYeastDrops.forEach((drop) => map.set(drop.day, drop));
        return map;
    }, [currentBatchYeastDrops]);

    const totalWarmBuckets = useMemo(
        () =>
            currentBatchYeastDrops
                .filter((d) => d.type === "warm")
                .reduce((sum, d) => sum + d.amount, 0),
        [currentBatchYeastDrops]
    );
    const totalColdBuckets = useMemo(
        () =>
            currentBatchYeastDrops
                .filter((d) => d.type === "cold")
                .reduce((sum, d) => sum + d.amount, 0),
        [currentBatchYeastDrops]
    );
    const totalYeastBuckets = totalWarmBuckets + totalColdBuckets;


    // ========================================================
    // STYLE AVERAGE DATA
    // ========================================================

    const styleAverageChartData = useMemo(() => {
        if (!styleAverages) return [];

        return Object.entries(styleAverages.days ?? {})
            .map(([day, values]) => ({
                day: Number(day),
                temp: values.temp ?? null,
                plato: values.plato ?? null,
                pH: values.pH ?? null,
                pressure: values.pressure ?? null,
                carbonation: values.carbonation ?? null,
            }))
            .sort((a, b) => a.day - b.day);
    }, [styleAverages]);


    // ========================================================
    // batchCount range (לתג ליד "ממוצע X")
    // ========================================================

    const averageBatchCountRange = useMemo(() => {
        if (!styleAverages) return null;

        const counts = Object.values(styleAverages.days ?? {})
            .map((d) => (d as StyleAverageDay).batchCount)
            .filter((c): c is number => typeof c === "number" && Number.isFinite(c));

        if (counts.length === 0) return null;

        const min = Math.min(...counts);
        const max = Math.max(...counts);

        return min === max ? `${min}` : `${min}–${max}`;
    }, [styleAverages]);


    // ========================================================
    // TOGGLE BATCH
    // ========================================================

    const selectBatch = (id: string) => {
        setSelectedBatchId((prev) => (prev === id ? null : id));
    };


    // ========================================================
    // TOGGLE METRIC
    // ========================================================

    const toggleMetric = (key: MetricKey) => {
        setSelectedMetrics((prev) =>
            prev.includes(key)
                ? prev.filter((metric) => metric !== key)
                : [...prev, key]
        );
    };


    // ========================================================
    // VISIBLE METRICS
    // ========================================================

    const visibleMetrics = useMemo(
        () => METRICS.filter((metric) => selectedMetrics.includes(metric.key)),
        [selectedMetrics]
    );


    // ========================================================
    // BUILD CHART DATA FOR A METRIC
    // ========================================================

    function buildMetricChartData(metric: MetricKey): ChartPoint[] {
        const map = new Map<number, ChartPoint>();

        currentBatchChartData.forEach((item) => {
            map.set(item.day, {
                ...(map.get(item.day) ?? { day: item.day }),
                day: item.day,
                current: item[metric],
            });
        });

        const maxCurrentDay =
            reportView !== "averages" && currentBatchChartData.length > 0
                ? Math.max(...currentBatchChartData.map((item) => item.day))
                : null;

        const limitedStyleAverageChartData =
            reportView === "averages"
                ? styleAverageChartData.filter((item) => item.day <= 50)
                : maxCurrentDay === null
                    ? []
                    : styleAverageChartData.filter((item) => item.day <= maxCurrentDay);

        limitedStyleAverageChartData.forEach((item) => {
            const existing = map.get(item.day) ?? { day: item.day };
            map.set(item.day, { ...existing, day: item.day, average: item[metric] });
        });

        return Array.from(map.values()).sort((a, b) => a.day - b.day);
    }

    const getYAxisDomain = (data: ChartPoint[]): [number, number] => {
        const values = data
            .map((point) => point.current)
            .filter(
                (value): value is number =>
                    value !== null && value !== undefined && Number.isFinite(value)
            );

        if (values.length === 0) return [0, 1];

        const min = Math.min(...values);
        const max = Math.max(...values);

        if (min === max) {
            const padding = Math.abs(min) * 0.1 || 1;
            return [min - padding, max + padding];
        }

        return [min, max];
    };


    // ========================================================
    // RENDER
    // ========================================================

    return (
        <div className="write-messurmant">

            {/* REPORT VIEW SWITCHER */}
            <div className="status-filter" style={{ marginBottom: 10 }}>
                {REPORT_VIEWS.map((view) => (
                    <button
                        key={view.key}
                        type="button"
                        className={`status-filter-button ${reportView === view.key ? "active" : ""}`}
                        onClick={() => handleReportViewChange(view.key)}
                    >
                        <span>{view.label}</span>
                    </button>
                ))}
            </div>


            {/* BATCH PICKER (current / old) */}
            {reportView !== "averages" && (
                <div className="status-filter" style={{ marginBottom: 10 }}>
                    {loadingBrews && <span>טוען אצוות...</span>}

                    {!loadingBrews && (
                        <select
                            value={selectedBatchId ?? ""}
                            onChange={(e) => selectBatch(e.target.value)}
                            style={{
                                minWidth: 220,
                                padding: "8px 12px",
                                borderRadius: 8,
                                border: "1px solid #cbd5e1",
                                background: "#fff",
                                fontSize: 14,
                            }}
                        >
                            <option value="">בחר אצווה</option>
                            {selectableBrews.map((b) => (
                                <option key={b.id} value={b.id}>
                                    #{b.batchNumber} {b.beerStyle}
                                </option>
                            ))}
                        </select>
                    )}

                    {!loadingBrews && selectableBrews.length === 0 && (
                        <span className="measurement-batch">אין אצוות להצגה בתצוגה זו</span>
                    )}
                </div>
            )}


            {/* STYLE PICKER (averages only) */}
            {reportView === "averages" && (
                <div className="status-filter" style={{ marginBottom: 10 }}>
                    {loadingStyles && <span>טוען סגנונות...</span>}

                    {!loadingStyles && (
                        <select
                            value={selectedAverageStyle ?? ""}
                            onChange={(e) => setSelectedAverageStyle(e.target.value || null)}
                            style={{
                                minWidth: 220,
                                padding: "8px 12px",
                                borderRadius: 8,
                                border: "1px solid #cbd5e1",
                                background: "#fff",
                                fontSize: 14,
                            }}
                        >
                            <option value="">בחר סגנון בירה</option>
                            {availableStyles.map((style) => (
                                <option key={style} value={style}>{style}</option>
                            ))}
                        </select>
                    )}

                    {!loadingStyles && availableStyles.length === 0 && (
                        <span className="measurement-batch">אין עדיין ממוצעים שמורים</span>
                    )}
                </div>
            )}


            {/* METRIC FILTER */}
            <div className="status-filter" style={{ marginBottom: 14 }}>
                {METRICS.map((metric) => (
                    <button
                        key={metric.key}
                        type="button"
                        className={`status-filter-button ${selectedMetrics.includes(metric.key) ? "active" : ""}`}
                        onClick={() => toggleMetric(metric.key)}
                        style={
                            selectedMetrics.includes(metric.key)
                                ? { borderColor: metric.color }
                                : undefined
                        }
                    >
                        <span
                            className="metric-color-dot"
                            style={{ backgroundColor: metric.color }}
                        />
                        {metric.label}
                    </button>
                ))}
            </div>


            {loadingData && <div className="measurementLoading">טוען נתונים...</div>}

            {!loadingData && reportView !== "averages" && !selectedBatchId && (
                <div className="measurementEmpty">בחר אצווה להצגה</div>
            )}

            {reportView === "averages" && !selectedAverageStyle && (
                <div className="measurementEmpty">בחר סגנון בירה להצגה</div>
            )}


            {hasSelection && (
                <div className="measurement-grid">

                    {reportView !== "averages" && (
                        <div className="measurement-card yeast-report-card">
                            <div className="measurement-header">
                                <span className="measurement-tank">שמרים</span>
                            </div>

                            {currentBatchYeastDrops.length === 0 ? (
                                <div className="measurementEmpty">אין עדיין הורדות שמרים רשומות</div>
                            ) : (
                                <>
                                    <div className="metric-chart-print-title">
                                        סה״כ {formatYeastTotal(totalYeastBuckets)} דליים
                                        {" "}(חם: {formatYeastTotal(totalWarmBuckets)} · קר: {formatYeastTotal(totalColdBuckets)})
                                    </div>

                                    <div className="batch-chart-graph" style={{ height: 160 }} dir="ltr">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <AreaChart
                                                data={yeastCumulativeData}
                                                margin={{ top: 10, right: 10, left: 0, bottom: 10 }}
                                            >
                                                <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                                                <XAxis
                                                    dataKey="day"
                                                    type="number"
                                                    {...getXAxisBounds(yeastCumulativeData.map((p) => p.day))}
                                                    label={{
                                                        value: "ימים מהבישול",
                                                        position: "insideBottom",
                                                        offset: -5,
                                                    }}
                                                />
                                                <YAxis width={40} allowDecimals />
                                                <Tooltip
                                                    content={({ active, payload, label }) => {
                                                        if (!active || !payload?.length || label === undefined) return null;
                                                        const drop = yeastDropsByDay.get(Number(label));
                                                        const cumulative = payload[0].value;
                                                        return (
                                                            <div className="chart-tooltip">
                                                                <div className="chart-tooltip-day">יום {label}</div>
                                                                <div className="chart-tooltip-value">
                                                                    סה״כ מצטבר: {cumulative} דליים
                                                                </div>
                                                                {drop && (
                                                                    <div className="chart-tooltip-value" style={{ color: "#058a05" }}>
                                                                        הורדה ביום זה: {formatYeastTotal(drop.amount)} דליים ·{" "}
                                                                        {drop.type === "cold" ? "קר" : "חם"}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    }}
                                                />
                                                <Area
                                                    type="stepAfter"
                                                    dataKey="cumulative"
                                                    stroke="#058a05"
                                                    fill="#058a05"
                                                    fillOpacity={0.15}
                                                    strokeWidth={2.5}
                                                    dot={{ r: 4, fill: "#058a05" }}
                                                    isAnimationActive={false}
                                                />
                                            </AreaChart>
                                        </ResponsiveContainer>
                                    </div>

                                    <div className="yeast-timeline">
                                        {currentBatchYeastDrops.map((drop) => (
                                            <div key={`${drop.day}-${drop.dateLabel}`} className="yeast-timeline-row">
                                                <span className="yeast-timeline-day">יום {drop.day}</span>
                                                <span className="yeast-timeline-date">{drop.dateLabel}</span>
                                                <span className={`yeast-badge ${drop.type}`}>
                                                    {drop.type === "cold" ? "❄️ קר" : "🔥 חם"}
                                                </span>
                                                <span className="yeast-timeline-amount">
                                                    {formatYeastTotal(drop.amount)} דליים
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {visibleMetrics.map((metric) => {

                        const chartData = buildMetricChartData(metric.key);

                        const { domain: xDomain, ticks: xTicks } = getXAxisBounds(
                            getMetricDayRange(chartData, reportView)
                        );

                        return (
                            <div key={metric.key} className="measurement-card">

                                <div className="measurement-header">
                                    <span className="measurement-tank">{metric.label}</span>

                                    {singleStyle && styleAverages && (
                                        <span className="measurement-style">
                                            ממוצע {singleStyle}
                                            {averageBatchCountRange
                                                ? ` · ${averageBatchCountRange} אצוות`
                                                : ""}
                                        </span>
                                    )}
                                </div>

                                <div className="batch-chart-graph" style={{ height: 260 }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart
                                            data={chartData}
                                            margin={{ top: 10, right: 10, left: 0, bottom: 10 }}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" />

                                            <XAxis
                                                dataKey="day"
                                                type="number"
                                                domain={xDomain}
                                                ticks={xTicks}
                                                tickFormatter={(value) => `${value}`}
                                                label={{
                                                    value: "ימים מהבישול",
                                                    position: "insideBottom",
                                                    offset: -5,
                                                }}
                                            />

                                            <YAxis domain={getYAxisDomain(chartData)} />

                                            <Tooltip content={makeAverageTooltipRenderer(styleAverages)} />

                                            {reportView !== "averages" && selectedBatchId && (
                                                <Line
                                                    type="monotone"
                                                    dataKey="current"
                                                    name={
                                                        `האצווה הנוכחית #${brews.find((b) => b.id === selectedBatchId)?.batchNumber ?? selectedBatchId
                                                        }`
                                                    }
                                                    stroke={metric.color}
                                                    strokeWidth={3}
                                                    dot={{ r: 4 }}
                                                    activeDot={{ r: 6 }}
                                                    connectNulls
                                                />
                                            )}

                                            {hasSelection && singleStyle && styleAverages && (
                                                <Line
                                                    type="monotone"
                                                    dataKey="average"
                                                    name={`ממוצע ${singleStyle}`}
                                                    stroke="#7c3aed"
                                                    strokeWidth={2}
                                                    strokeDasharray={reportView === "averages" ? undefined : "6 4"}
                                                    dot={reportView === "averages"}
                                                    connectNulls
                                                />
                                            )}

                                            {/* זום — עובד גם בגרירת אצבע במובייל */}
                                            <Brush
                                                dataKey="day"
                                                height={22}
                                                stroke={metric.color}
                                                travellerWidth={14}
                                                tickFormatter={(value) => `${value}`}
                                            />

                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>

                            </div>
                        );
                    })}
                </div>
            )}

        </div>
    );
}
