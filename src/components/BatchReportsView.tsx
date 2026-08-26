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
} from "recharts";

import {
    getAllBrewsSummary,
    type BrewSummary,
} from "../SERVICES/getAllBrews";

import {
    getMeasurementsByBatch,
} from "../SERVICES/gettAllDataByBatch";

import {
    getStyleAverages,
    type StyleAverages,
} from "../SERVICES/getStyleAverages";


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
};


type ChartPoint = {
    day: number;
    current?: number | null;
    average?: number | null;
};


// ============================================================
// METRICS
// ============================================================

const METRICS: MetricDefinition[] = [
    {
        key: "temp",
        label: "טמפ׳",
    },
    {
        key: "plato",
        label: "סוכר (Plato)",
    },
    {
        key: "pH",
        label: "pH",
    },
    {
        key: "pressure",
        label: "לחץ",
    },
    {
        key: "carbonation",
        label: "גיזוז",
    },
];


// ============================================================
// DATE HELPERS
// ============================================================

function parseDate(value: string): Date | null {

    if (!value) {
        return null;
    }

    const str =
        String(value).trim();

    // dd/mm/yyyy
    // dd/mm/yy

    const match =
        str.match(
            /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
        );

    if (!match) {
        return null;
    }

    const day =
        Number(match[1]);

    const month =
        Number(match[2]);

    let year =
        Number(match[3]);

    if (year < 100) {
        year += 2000;
    }

    const result =
        new Date(
            year,
            month - 1,
            day
        );

    // Validate date

    if (
        result.getFullYear() !== year ||
        result.getMonth() !== month - 1 ||
        result.getDate() !== day
    ) {
        return null;
    }

    return result;
}


// ============================================================
// DAY SINCE BREW
// ============================================================

function getDayFromBrew(
    brewDateString: string,
    measurementDateString: string
): number | null {

    const brewDate =
        parseDate(brewDateString);

    const measurementDate =
        parseDate(measurementDateString);

    if (
        !brewDate ||
        !measurementDate
    ) {
        return null;
    }

    const start =
        new Date(
            brewDate.getFullYear(),
            brewDate.getMonth(),
            brewDate.getDate()
        );

    const end =
        new Date(
            measurementDate.getFullYear(),
            measurementDate.getMonth(),
            measurementDate.getDate()
        );

    return Math.round(
        (
            end.getTime() -
            start.getTime()
        ) /
        (1000 * 60 * 60 * 24)
    );
}


// ============================================================
// COMPONENT
// ============================================================

export default function BatchReportsView() {

    // ========================================================
    // STATE
    // ========================================================

    const [brews, setBrews] =
        useState<BrewSummary[]>([]);

    const [loadingBrews, setLoadingBrews] =
        useState(true);

    const [selectedBatchId, setSelectedBatchId] =
        useState<string | null>(null);

    const [selectedMetrics, setSelectedMetrics] =
        useState<MetricKey[]>(
            METRICS.map(
                (m) => m.key
            )
        );

    const [dataByBatch, setDataByBatch] =
        useState<
            Record<string, Measurement[]>
        >({});

    const [styleAverages, setStyleAverages] =
        useState<StyleAverages | null>(null);

    const [loadingData, setLoadingData] =
        useState(false);


    // ========================================================
    // LOAD BREWS
    // ========================================================

    useEffect(() => {

        getAllBrewsSummary()
            .then(setBrews)
            .finally(
                () =>
                    setLoadingBrews(false)
            );

    }, []);


    // ========================================================
    // SELECTED STYLE
    // ========================================================

    const singleStyle =
        useMemo(() => {

            if (!selectedBatchId) {
                return null;
            }

            const style =
                brews.find(
                    (b) => b.id === selectedBatchId
                )?.beerStyle;

            return style ? String(style) : null;

        }, [
            selectedBatchId,
            brews,
        ]);


    // ========================================================
    // LOAD STYLE AVERAGE
    // ========================================================

    useEffect(() => {

        if (!singleStyle) {

            setStyleAverages(null);

            return;
        }

        let cancelled = false;

        getStyleAverages(
            singleStyle
        )
            .then((result) => {

                if (!cancelled) {
                    setStyleAverages(result);
                }

            })
            .catch((error) => {

                console.error(
                    "Failed loading style averages:",
                    error
                );

                if (!cancelled) {
                    setStyleAverages(null);
                }

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
                if (cancelled) {
                    return;
                }

                setDataByBatch({
                    [selectedBatchId]: measurements as Measurement[],
                });
            })

            .catch((error) => {

                console.error(
                    "Failed loading measurements:",
                    error
                );

            })
            .finally(() => {

                if (!cancelled) {
                    setLoadingData(false);
                }

            });

        return () => {
            cancelled = true;
        };

    }, [selectedBatchId]);


    // ========================================================
    // CURRENT BATCH DATA
    // ========================================================

    const currentBatchChartData =
        useMemo(() => {

            // Style comparison makes sense
            // when one batch is selected.

            if (!selectedBatchId) {
                return [];
            }

            const batchId =
                selectedBatchId;

            const brew =
                brews.find(
                    (b) =>
                        b.id === batchId
                );

            if (!brew) {
                return [];
            }

            const measurements =
                dataByBatch[batchId] ?? [];

            return measurements
                .map((measurement) => {

                    const day =
                        getDayFromBrew(
                            brew.brewDate,
                            measurement.date
                        );

                    if (day === null) {
                        return null;
                    }

                    return {
                        day,

                        temp:
                            measurement.temp ??
                            null,

                        plato:
                            measurement.plato ??
                            null,

                        pH:
                            measurement.pH ??
                            null,

                        pressure:
                            measurement.pressure ??
                            null,

                        carbonation:
                            measurement.carbonation ??
                            null,
                    };

                })
                .filter(
                    (
                        item
                    ): item is NonNullable<typeof item> =>
                        item !== null
                )
                .sort(
                    (a, b) =>
                        a.day - b.day
                );

        }, [
            selectedBatchId,
            brews,
            dataByBatch,
        ]);


    // ========================================================
    // STYLE AVERAGE DATA
    // ========================================================

    const styleAverageChartData =
        useMemo(() => {

            if (!styleAverages) {
                return [];
            }

            return Object.entries(
                styleAverages.days ?? {}
            )
                .map(
                    ([day, values]) => ({
                        day:
                            Number(day),

                        temp:
                            values.temp ??
                            null,

                        plato:
                            values.plato ??
                            null,

                        pH:
                            values.pH ??
                            null,

                        pressure:
                            values.pressure ??
                            null,

                        carbonation:
                            values.carbonation ??
                            null,
                    })
                )
                .sort(
                    (a, b) =>
                        a.day - b.day
                );

        }, [
            styleAverages,
        ]);


    // ========================================================
    // TOGGLE BATCH
    // ========================================================

    const selectBatch =
        (id: string) => {

            setSelectedBatchId(
                (prev) => prev === id ? null : id
            );

        };


    // ========================================================
    // TOGGLE METRIC
    // ========================================================

    const toggleMetric =
        (key: MetricKey) => {

            setSelectedMetrics(
                (prev) =>

                    prev.includes(key)

                        ? prev.filter(
                            (metric) =>
                                metric !== key
                        )

                        : [
                            ...prev,
                            key,
                        ]
            );

        };


    // ========================================================
    // VISIBLE METRICS
    // ========================================================

    const visibleMetrics =
        useMemo(
            () =>
                METRICS.filter(
                    (metric) =>
                        selectedMetrics.includes(
                            metric.key
                        )
                ),
            [selectedMetrics]
        );


    // ========================================================
    // BUILD CHART DATA FOR A METRIC
    // ========================================================

    function buildMetricChartData(
        metric: MetricKey
    ): ChartPoint[] {

        const map =
            new Map<number, ChartPoint>();


        // ----------------------------------------------------
        // CURRENT BATCH
        // ----------------------------------------------------

        currentBatchChartData.forEach(
            (item) => {

                map.set(
                    item.day,
                    {
                        ...(map.get(item.day) ?? {
                            day: item.day,
                        }),

                        day: item.day,

                        current:
                            item[metric],
                    }
                );

            }
        );


        // ----------------------------------------------------
        // STYLE AVERAGE
        // ----------------------------------------------------

        // The style average must never extend beyond the last
        // day that actually exists in the selected batch.
        const maxCurrentDay =
            currentBatchChartData.length > 0
                ? Math.max(
                    ...currentBatchChartData.map(
                        (item) => item.day
                    )
                )
                : null;

        const limitedStyleAverageChartData =
            maxCurrentDay === null
                ? []
                : styleAverageChartData.filter(
                    (item) => item.day <= maxCurrentDay
                );

        limitedStyleAverageChartData.forEach(
            (item) => {

                const existing =
                    map.get(item.day) ?? {
                        day: item.day,
                    };

                map.set(
                    item.day,
                    {
                        ...existing,

                        day: item.day,

                        average:
                            item[metric],
                    }
                );

            }
        );


        return Array.from(
            map.values()
        ).sort(
            (a, b) =>
                a.day - b.day
        );
    }

    const getYAxisDomain = (
        data: ChartPoint[]
    ): [number, number] => {
        const values = data
            .map((point) => point.current)
            .filter(
                (value): value is number =>
                    value !== null &&
                    value !== undefined &&
                    Number.isFinite(value)
            );

        if (values.length === 0) {
            return [0, 1];
        }

        const min = Math.min(...values);
        const max = Math.max(...values);

        if (min === max) {
            const padding = Math.abs(min) * 0.1 || 1;

            return [
                min - padding,
                max + padding,
            ];
        }

        return [min, max];
    };
    // ========================================================
    // RENDER
    // ========================================================

    return (

        <div className="write-messurmant">

            {/* =================================================
                BATCH PICKER
            ================================================= */}

            <div
                className="status-filter"
                style={{
                    marginBottom: 10,
                }}
            >

                {loadingBrews && (
                    <span>
                        טוען אצוות...
                    </span>
                )}

                {!loadingBrews && (
                    <select
                        value={selectedBatchId ?? ""}
                        onChange={(e) =>
                            selectBatch(e.target.value)
                        }
                        style={{
                            minWidth: 220,
                            padding: "8px 12px",
                            borderRadius: 8,
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            fontSize: 14,
                        }}
                    >
                        <option value="">
                            בחר אצווה
                        </option>

                        {brews.map((b) => (
                            <option
                                key={b.id}
                                value={b.id}
                            >
                                #{b.batchNumber} {b.beerStyle}
                            </option>
                        ))}
                    </select>
                )}

            </div>


            {/* =================================================
                METRIC FILTER
            ================================================= */}

            <div
                className="status-filter"
                style={{
                    marginBottom: 14,
                }}
            >

                {METRICS.map(
                    (metric) => (

                        <button
                            key={metric.key}
                            type="button"
                            className={
                                `status-filter-button ${selectedMetrics.includes(
                                    metric.key
                                )
                                    ? "active"
                                    : ""
                                }`
                            }
                            onClick={() =>
                                toggleMetric(
                                    metric.key
                                )
                            }
                        >

                            {metric.label}

                        </button>

                    )
                )}

            </div>


            {/* =================================================
                LOADING
            ================================================= */}

            {loadingData && (
                <div className="measurementLoading">
                    טוען נתונים...
                </div>
            )}


            {/* =================================================
                EMPTY
            ================================================= */}

            {!loadingData &&
                !selectedBatchId && (

                    <div className="measurementEmpty">
                        בחר אצווה להצגה
                    </div>

                )}


            {/* =================================================
                MULTIPLE BATCH WARNING
            ================================================= */}




            {/* =================================================
                STYLE INFO
            ================================================= */}


            <div className="measurement-grid">

                {visibleMetrics.map(
                    (metric) => {

                        const chartData =
                            buildMetricChartData(
                                metric.key
                            );


                        return (

                            <div
                                key={metric.key}
                                className="measurement-card"
                            >

                                {/* ---------------------------------
                                    HEADER
                                --------------------------------- */}

                                <div
                                    className="measurement-header"
                                >

                                    <span
                                        className="measurement-tank"
                                    >
                                        {metric.label}
                                    </span>

                                    {singleStyle &&
                                        styleAverages && (

                                            <span
                                                className="measurement-style"
                                            >
                                                ממוצע{" "}
                                                {singleStyle}
                                            </span>

                                        )}

                                </div>


                                {/* ---------------------------------
                                    CHART
                                --------------------------------- */}

                                <div
                                    className="batch-chart-graph"
                                    style={{
                                        height: 220,
                                    }}
                                >

                                    <ResponsiveContainer
                                        width="100%"
                                        height="100%"
                                    >

                                        <LineChart
                                            data={chartData}
                                            margin={{
                                                top: 10,
                                                right: 10,
                                                left: 0,
                                                bottom: 10,
                                            }}
                                        >

                                            <CartesianGrid
                                                strokeDasharray="3 3"
                                            />

                                            <XAxis
                                                dataKey="day"
                                                type="number"
                                                domain={[
                                                    "dataMin",
                                                    "dataMax",
                                                ]}
                                                tickFormatter={(
                                                    value
                                                ) =>
                                                    `${value}`
                                                }
                                                label={{
                                                    value:
                                                        "ימים מהבישול",
                                                    position:
                                                        "insideBottom",
                                                    offset:
                                                        -5,
                                                }}
                                            />

                                            <YAxis  domain={getYAxisDomain(chartData)}/>

                                            <Tooltip
                                                labelFormatter={(
                                                    value
                                                ) =>
                                                    `יום ${value}`
                                                }
                                            />


                                            {/* =================================
                                                CURRENT BATCH
                                            ================================= */}

                                            {selectedBatchId && (

                                                <Line
                                                    type="monotone"
                                                    dataKey="current"
                                                    name={
                                                        `האצווה הנוכחית #${brews.find(
                                                            (b) => b.id === selectedBatchId
                                                        )?.batchNumber ?? selectedBatchId
                                                        }`
                                                    }
                                                    stroke="#e89413"
                                                    strokeWidth={3}
                                                    dot={{
                                                        r: 4,
                                                    }}
                                                    activeDot={{
                                                        r: 6,
                                                    }}
                                                    connectNulls
                                                />

                                            )}


                                            {/* =================================
                                                STYLE AVERAGE
                                            ================================= */}

                                            {selectedBatchId &&
                                                singleStyle &&
                                                styleAverages && (

                                                    <Line
                                                        type="monotone"
                                                        dataKey="average"
                                                        name={
                                                            `ממוצע ${singleStyle}`
                                                        }
                                                        stroke="#7c3aed"
                                                        strokeWidth={2}
                                                        strokeDasharray="6 4"
                                                        dot={false}
                                                        connectNulls
                                                    />

                                                )}

                                        </LineChart>

                                    </ResponsiveContainer>

                                </div>

                            </div>

                        );

                    }
                )}

            </div>

        </div>
    );
}