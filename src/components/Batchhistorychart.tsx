import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
  ReferenceLine,
  Legend,
  AreaChart,
  Area,
} from "recharts";

import type { TooltipContentProps } from "recharts";
import { getMeasurementsByBatch } from "../SERVICES/gettAllDataByBatch";
import { extractYeastDrops, type Measurement, type YeastDrop } from "../SERVICES/calculateCelleringRecomendations";
import type { Fermentor } from "../App";
import {
  getStyleAverages,
  type StyleAverages,
} from "../SERVICES/getStyleAverages";

// ============================================================
// TYPES
// ============================================================

type BatchHistoryChartProps = {
  tank: Fermentor;
  onClose: () => void;
};

type MetricKey = "plato" | "pH" | "temp" | "pressure" | "carbonation";

type ChartPoint = {
  day: number;
  dateLabel: string;
  plato: number | null;
  pH: number | null;
  temp: number | null;
  pressure: number | null;
  carbonation: number | null;

  // ממוצע הסגנון
  averagePlato?: number | null;
  averagePH?: number | null;
  averageTemp?: number | null;
  averagePressure?: number | null;
  averageCarbonation?: number | null;

  yeastNote: string | null;
};

type ViewMode = "tabs" | "combined";

const METRICS: {
  key: MetricKey;
  label: string;
  unit: string;
  color: string;
}[] = [
    { key: "plato", label: "סוכר", unit: "°P", color: "#d99323" },
    { key: "pH", label: "pH", unit: "", color: "#5b8def" },
    { key: "temp", label: "טמפ׳", unit: "°C", color: "#e0563f" },
    { key: "pressure", label: "לחץ", unit: "bar", color: "#3fa796" },
    { key: "carbonation", label: "גיזוז", unit: "vol", color: "#0891b2" },
  ];

// מיפוי בין מדד למפתח הממוצע המתאים ב-ChartPoint
const AVERAGE_KEY_BY_METRIC: Record<MetricKey, keyof ChartPoint> = {
  plato: "averagePlato",
  pH: "averagePH",
  temp: "averageTemp",
  pressure: "averagePressure",
  carbonation: "averageCarbonation",
};

// המילה שמחפשים בהערות כדי להציג אותן כציון-דרך על הגרף
const YEAST_KEYWORD = "שמרים";

// ============================================================
// DATE PARSING
// המדידות לא מכילות שדה date - התאריך חבוי בתוך ה-id
// בפורמט "YYYY-MM-DD_HHMM"
// ============================================================

function parseBrewDate(brewDate: string | null | undefined): Date | null {
  if (!brewDate) return null;
  const parts = String(brewDate).trim().split("/");
  if (parts.length !== 3) return null;

  const day = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  let year = Number(parts[2]);
  if (year < 100) year += 2000;

  const date = new Date(year, month, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMeasurementDate(id: Measurement["id"]): Date | null {
  if (id === null || id === undefined) return null;

  const match = String(id).match(/^(\d{4})-(\d{2})-(\d{2})_\d{4}$/);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDays(a: Date, b: Date): number {
  const start = new Date(a);
  const end = new Date(b);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((start.getTime() - end.getTime()) / (1000 * 60 * 60 * 24));
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * עוגן משותף ליום 0, כדי ש-buildChartData ו-buildYeastChartData
 * ימנו את הימים בדיוק אותו הדבר (במקום שכל פונקציה תחשב עוגן בנפרד
 * ואולי תתפצל ליומיים שונים).
 */
function computeAnchor(
  tank: Fermentor,
  parsedRows: { date: Date }[]
): Date | null {
  const brewDate = parseBrewDate(tank.brewDate);
  if (brewDate) return brewDate;
  if (parsedRows.length > 0) return parsedRows[0].date;
  return null;
}

// ============================================================
// AXIS HELPERS
// ============================================================

// טווח X הדוק לנתונים בפועל, עם עד 5 טיקים מפוזרים (לא רק מינימום/מקסימום)
function getXAxisBounds(
  days: number[]
): { domain: [number, number]; ticks: number[] } {

  const validDays = days.filter(
    (d): d is number => Number.isFinite(d)
  );

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

// טווח Y הדוק לנתונים בפועל של מדד ספציפי (כל מדד יכול לנוע בסקאלה שונה לגמרי)
function getYAxisDomain(
  data: ChartPoint[],
  key: MetricKey,
  averageKey: keyof ChartPoint
): [number, number] {

  const values = data
    .flatMap((point) => [point[key], point[averageKey]])
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
    return [min - padding, max + padding];
  }

  const padding = (max - min) * 0.05;
  return [min - padding, max + padding];
}

// ============================================================
// BUILD CHART DATA
// ============================================================

function buildChartData(
  tank: Fermentor,
  measurements: Measurement[],
  anchor: Date | null
): ChartPoint[] {

  const parsedRows = measurements
    .map((m) => ({ m, date: parseMeasurementDate(m.id) }))
    .filter((r): r is { m: Measurement; date: Date } => r.date !== null);

  parsedRows.sort((a, b) => a.date.getTime() - b.date.getTime());

  const points: ChartPoint[] = parsedRows.map((row) => {
    const day = anchor ? diffDays(row.date, anchor) : 0;
    const notes =
      row.m.notes !== null && row.m.notes !== undefined ? String(row.m.notes) : "";

    const rawCarbonation = (row.m as unknown as Record<string, unknown>).carbonation;

    return {
      day,
      dateLabel: row.date.toLocaleDateString("he-IL"),
      plato: toNumberOrNull(row.m.plato),
      pH: toNumberOrNull(row.m.pH),
      temp: toNumberOrNull(row.m.temp),
      pressure: toNumberOrNull(row.m.pressure),
      carbonation: toNumberOrNull(rawCarbonation),
      yeastNote: notes.includes(YEAST_KEYWORD) ? notes : null,
    };
  });

  // Starting Plato -> יום 0.
  const startingPlato = toNumberOrNull(tank.startingPlato);
  if (startingPlato !== null) {
    const dayZero = points.find((p) => p.day === 0);
    if (dayZero) {
      if (dayZero.plato === null) dayZero.plato = startingPlato;
    } else {
      points.unshift({
        day: 0,
        dateLabel: anchor ? anchor.toLocaleDateString("he-IL") : "",
        plato: startingPlato,
        pH: null,
        temp: null,
        pressure: null,
        carbonation: null,
        yeastNote: null,
      });
    }
  }

  return points.sort((a, b) => a.day - b.day);
}

// ============================================================
// COMBINED (NORMALIZED) CHART DATA
// כל מדד מנורמל ל-0..1 כדי שכל הקווים יחיו על אותו ציר Y.
// הערכים האמיתיים נשלפים בטולטיפ מתוך chartData לפי היום.
// ============================================================

type CombinedPoint = { day: number } & Partial<Record<MetricKey, number | null>>;

function buildCombinedData(chartData: ChartPoint[]): CombinedPoint[] {
  const ranges: Partial<Record<MetricKey, { min: number; max: number }>> = {};

  METRICS.forEach((metric) => {
    const values = chartData
      .map((p) => p[metric.key])
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

    if (values.length > 0) {
      ranges[metric.key] = { min: Math.min(...values), max: Math.max(...values) };
    }
  });

  return chartData.map((point) => {
    const combined: CombinedPoint = { day: point.day };

    METRICS.forEach((metric) => {
      const raw = point[metric.key];
      const range = ranges[metric.key];

      if (raw === null || raw === undefined || !range) {
        combined[metric.key] = null;
        return;
      }

      combined[metric.key] =
        range.max === range.min ? 0.5 : (raw - range.min) / (range.max - range.min);
    });

    return combined;
  });
}

// ============================================================
// TOOLTIPS
// ============================================================

function makeYeastNoteLine(
  day: number,
  yeastDropsByDay: Map<number, YeastChartPoint>
): string | null {
  const drop = yeastDropsByDay.get(day);
  if (!drop) return null;
  return `🟢 ${formatYeastTotal(drop.amount)} דליים (${drop.type === "cold" ? "קר" : "חם"})`;
}

function makeTooltipRenderer(
  metric: (typeof METRICS)[number],
  chartData: ChartPoint[],
  styleAverages: StyleAverages | null,
  yeastDropsByDay: Map<number, YeastChartPoint>
) {
  return function TooltipRenderer({ active, label, payload }: TooltipContentProps) {
    if (!active || !payload || payload.length === 0 || label === undefined) {
      return null;
    }

    const dayNumber = Number(label);
    const point = chartData.find((p) => p.day === dayNumber);
    const dayInfo = styleAverages?.days?.[String(dayNumber)];
    const yeastLine = makeYeastNoteLine(dayNumber, yeastDropsByDay);

    return (
      <div className="chart-tooltip">
        <div className="chart-tooltip-day">
          יום {dayNumber}
          {point?.dateLabel ? ` (${point.dateLabel})` : ""}
        </div>

        {payload.map((entry) => {
          const isAverage = entry.dataKey === AVERAGE_KEY_BY_METRIC[metric.key];
          const raw = entry.value;
          const text =
            raw === null || raw === undefined || raw === ""
              ? "—"
              : isAverage
                ? `${raw}`
                : `${raw}${metric.unit}`;

          return (
            <div
              key={String(entry.dataKey)}
              className="chart-tooltip-value"
              style={{ color: entry.color }}
            >
              {entry.name}: {text}
              {isAverage && dayInfo?.batchCount
                ? ` (מבוסס על ${dayInfo.batchCount} אצוות)`
                : ""}
            </div>
          );
        })}

        {yeastLine && (
          <div className="chart-tooltip-value" style={{ color: "#058a05" }}>
            {yeastLine}
          </div>
        )}
      </div>
    );
  };
}

function makeCombinedTooltipRenderer(
  chartData: ChartPoint[],
  yeastDropsByDay: Map<number, YeastChartPoint>
) {
  return function CombinedTooltipRenderer({ active, label }: TooltipContentProps) {
    if (!active || label === undefined) return null;

    const dayNumber = Number(label);
    const point = chartData.find((p) => p.day === dayNumber);
    if (!point) return null;

    const yeastLine = makeYeastNoteLine(dayNumber, yeastDropsByDay);

    return (
      <div className="chart-tooltip">
        <div className="chart-tooltip-day">
          יום {dayNumber}
          {point.dateLabel ? ` (${point.dateLabel})` : ""}
        </div>

        {METRICS.map((metric) => {
          const raw = point[metric.key];
          if (raw === null || raw === undefined) return null;

          return (
            <div
              key={metric.key}
              className="chart-tooltip-value"
              style={{ color: metric.color }}
            >
              {metric.label}: {raw}
              {metric.unit}
            </div>
          );
        })}

        {yeastLine && (
          <div className="chart-tooltip-value" style={{ color: "#058a05" }}>
            {yeastLine}
          </div>
        )}
      </div>
    );
  };
}

type YeastChartPoint = {
  day: number;
  amount: number;
  note: string;
  type: "warm" | "cold";
  dateLabel: string;
};

function formatDropDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, , month, day] = match;
  return `${day}/${month}`;
}

function buildYeastChartData(drops: YeastDrop[], anchor: Date | null): YeastChartPoint[] {
  if (!anchor) return [];

  return drops
    .map((drop) => {
      const dropDate = new Date(`${drop.date}T00:00:00`);
      if (Number.isNaN(dropDate.getTime())) return null;
      return {
        day: diffDays(dropDate, anchor),
        amount: drop.amount,
        note: drop.note,
        type: drop.type,
        dateLabel: formatDropDate(drop.date),
      };
    })
    .filter((p): p is YeastChartPoint => p !== null)
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

function formatYeastTotal(amount: number): string {
  return String(Number(amount.toFixed(2)));
}

// ============================================================
// COMPONENT
// ============================================================

function BatchHistoryChart({ tank, onClose }: BatchHistoryChartProps) {
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [styleAverages, setStyleAverages] =
    useState<StyleAverages | null>(null);

  const yeastDrops = useMemo(() => extractYeastDrops(measurements), [measurements]);

  const totalWarmBuckets = useMemo(
    () => yeastDrops.filter((d) => d.type === "warm").reduce((sum, d) => sum + d.amount, 0),
    [yeastDrops]
  );
  const totalColdBuckets = useMemo(
    () => yeastDrops.filter((d) => d.type === "cold").reduce((sum, d) => sum + d.amount, 0),
    [yeastDrops]
  );
  const totalBuckets = totalWarmBuckets + totalColdBuckets;

  const [activeMetric, setActiveMetric] = useState<MetricKey | "yeast">("plato");
  const [viewMode, setViewMode] = useState<ViewMode>("combined");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const batchId = tank.batchNumber;
        if (!batchId) {
          if (!cancelled) setMeasurements([]);
          return;
        }
        const data = await getMeasurementsByBatch(batchId as string | number);
        if (!cancelled) setMeasurements(data);
      } catch (e) {
        console.error("Failed to load measurements:", e);
        if (!cancelled) setError("שגיאה בטעינת הנתונים");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [tank.batchNumber]);

  useEffect(() => {
    const style = tank.beerStyle
      ? String(tank.beerStyle).trim()
      : "";

    if (!style) {
      setStyleAverages(null);
      return;
    }

    let cancelled = false;

    getStyleAverages(style)
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
  }, [tank.beerStyle]);

  // עוגן משותף לכל חישובי הימים (גרפי מדדים + גרף שמרים + הטולטיפים)
  const anchor = useMemo(() => {
    const parsedRows = measurements
      .map((m) => parseMeasurementDate(m.id))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())
      .map((date) => ({ date }));
    return computeAnchor(tank, parsedRows);
  }, [tank, measurements]);

  const chartData = useMemo(
    () => buildChartData(tank, measurements, anchor),
    [tank, measurements, anchor]
  );

  const yeastChartData = useMemo(
    () => buildYeastChartData(yeastDrops, anchor),
    [yeastDrops, anchor]
  );

  const yeastDropsByDay = useMemo(() => {
    const map = new Map<number, YeastChartPoint>();
    yeastChartData.forEach((drop) => map.set(drop.day, drop));
    return map;
  }, [yeastChartData]);

  const yeastCumulativeData = useMemo(
    () => buildYeastCumulativeData(yeastChartData),
    [yeastChartData]
  );

  const combinedData = useMemo(() => buildCombinedData(chartData), [chartData]);

  const chartDataWithAverage = useMemo(() => {
    if (!styleAverages) {
      return chartData;
    }

    const maxCurrentDay =
      chartData.length > 0
        ? Math.max(...chartData.map((p) => p.day))
        : null;

    const result = chartData.map((point) => ({
      ...point,
    }));

    Object.entries(styleAverages.days ?? {}).forEach(
      ([dayString, values]) => {
        const day = Number(dayString);

        if (
          maxCurrentDay !== null &&
          day > maxCurrentDay
        ) {
          return;
        }

        const existing = result.find(
          (p) => p.day === day
        );

        if (existing) {
          existing.averagePlato = values.plato ?? null;
          existing.averagePH = values.pH ?? null;
          existing.averageTemp = values.temp ?? null;
          existing.averagePressure = values.pressure ?? null;
          existing.averageCarbonation = values.carbonation ?? null;
        } else {
          result.push({
            day,
            dateLabel: "",
            plato: null,
            pH: null,
            temp: null,
            pressure: null,
            carbonation: null,
            averagePlato: values.plato ?? null,
            averagePH: values.pH ?? null,
            averageTemp: values.temp ?? null,
            averagePressure: values.pressure ?? null,
            averageCarbonation: values.carbonation ?? null,
            yeastNote: null,
          });
        }
      }
    );

    return result.sort(
      (a, b) => a.day - b.day
    );
  }, [chartData, styleAverages]);

  function handlePrint() {
    window.print();
  }

  function selectMetric(metric: MetricKey | "yeast") {
    setActiveMetric(metric);
    setViewMode("tabs");
  }

  function toggleCombined() {
    setViewMode((v) => (v === "combined" ? "tabs" : "combined"));
  }

  const combinedXBounds = getXAxisBounds(combinedData.map((p) => p.day));

  return (
    <div className="batch-chart-overlay" onClick={onClose}>
      <div className="batch-chart-modal" onClick={(e) => e.stopPropagation()}>
        <div className="batch-chart-header">
          <div>
            <div className="batch-chart-title">
              מיכל {tank.tankNumber ?? tank.uid} — #{tank.batchNumber ?? "—"}
            </div>
            <div className="batch-chart-subtitle">{tank.beerStyle ?? ""}</div>
          </div>
          <button
            type="button"
            className="batch-chart-close"
            onClick={onClose}
            aria-label="סגור"
          >
            ✕
          </button>
        </div>

        {loading && <div className="batch-chart-status">טוען נתונים...</div>}
        {error && <div className="batch-chart-status">{error}</div>}
        {!loading && !error && chartData.length === 0 && (
          <div className="batch-chart-status">אין עדיין מדידות לאצווה זו</div>
        )}

        {!loading && !error && chartData.length > 0 && (
          <>
            <div className="chart-metric-tabs">
              {METRICS.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  className={`chart-metric-tab ${viewMode === "tabs" && activeMetric === metric.key ? "active" : ""
                    }`}
                  onClick={() => selectMetric(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
              <button
                type="button"
                className={`chart-metric-tab ${viewMode === "tabs" && activeMetric === "yeast" ? "active" : ""
                  }`}
                onClick={() => selectMetric("yeast")}
              >
                שמרים
              </button>
              <button
                type="button"
                className={`chart-metric-tab ${viewMode === "combined" ? "active" : ""}`}
                onClick={toggleCombined}
              >
                הכל ביחד
              </button>
            </div>

            {/* סיכום שמרים קבוע - מוצג תמיד, לא תלוי באיזה טאב פתוח */}
            {totalBuckets > 0 && (
              <div className="chart-yeast-summary">
                🟢 סה״כ שמרים: {formatYeastTotal(totalBuckets)} דליים
                {" "}(חם: {formatYeastTotal(totalWarmBuckets)} · קר: {formatYeastTotal(totalColdBuckets)})
              </div>
            )}

            {/* גרף השמרים - מצטבר + רשימת אירועים, במקום עמודות בודדות על ציר ריק */}
            <div
              className={`metric-chart-block ${viewMode === "tabs" && activeMetric === "yeast" ? "active" : ""
                }`}
            >
              <div className="metric-chart-print-title">
                שמרים — סה״כ {formatYeastTotal(totalBuckets)} דליים
                {" "}(חם: {formatYeastTotal(totalWarmBuckets)} · קר: {formatYeastTotal(totalColdBuckets)})
              </div>

              {yeastChartData.length === 0 ? (
                <div className="batch-chart-status">אין עדיין הורדות שמרים רשומות</div>
              ) : (
                <>
                  <div className="batch-chart-graph" dir="ltr">
                    <ResponsiveContainer width="100%" height={160}>
                      <AreaChart
                        data={yeastCumulativeData}
                        margin={{ top: 10, right: 16, left: 0, bottom: 8 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis
                          dataKey="day"
                          type="number"
                          {...getXAxisBounds(yeastCumulativeData.map((p) => p.day))}
                          label={{ value: "ימים מהבישול", position: "insideBottom", offset: -4, fontSize: 12 }}
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
                                <div className="chart-tooltip-value">סה״כ מצטבר: {cumulative} דליים</div>
                                {drop && (
                                  <div className="chart-tooltip-value" style={{ color: "#058a05" }}>
                                    הורדה ביום זה: {formatYeastTotal(drop.amount)} דליים · {drop.type === "cold" ? "קר" : "חם"}
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
                    {yeastChartData.map((drop) => (
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

            {/* גרף "הכל ביחד" - כל המדדים מנורמלים 0..1 על אותו ציר, ערכים אמיתיים בטולטיפ */}
            <div className={`metric-chart-block ${viewMode === "combined" ? "active" : ""}`}>
              <div className="metric-chart-print-title">הכל ביחד (מנורמל)</div>
              <div className="batch-chart-graph" dir="ltr">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={combinedData} margin={{ top: 10, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                    <XAxis
                      dataKey="day"
                      type="number"
                      domain={combinedXBounds.domain}
                      ticks={combinedXBounds.ticks}
                      label={{ value: "ימים מהבישול", position: "insideBottom", offset: -4, fontSize: 12 }}
                    />
                    <YAxis
                      width={40}
                      domain={[0, 1]}
                      ticks={[0, 0.5, 1]}
                      tickFormatter={(v) => (v === 0 ? "נמוך" : v === 1 ? "גבוה" : "")}
                    />
                    <Tooltip content={makeCombinedTooltipRenderer(chartData, yeastDropsByDay)} />
                    <Legend
                      verticalAlign="bottom"
                      align="center"
                      wrapperStyle={{ paddingTop: 10, direction: "rtl" }}
                    />

                    {METRICS.map((metric) => (
                      <Line
                        key={metric.key}
                        type="monotone"
                        dataKey={metric.key}
                        name={metric.label}
                        stroke={metric.color}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ))}

                    {yeastChartData.map((drop) => (
                      <ReferenceLine
                        key={`yeast-line-${drop.day}`}
                        x={drop.day}
                        stroke="#058a05"
                        strokeDasharray="4 3"
                        strokeOpacity={0.6}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {METRICS.map((metric) => {

              const metricDays = chartData
                .filter((p) => p[metric.key] !== null && p[metric.key] !== undefined)
                .map((p) => p.day);

              const { domain: xDomain, ticks: xTicks } = getXAxisBounds(metricDays);

              return (
                <div
                  key={metric.key}
                  className={`metric-chart-block ${viewMode === "tabs" && activeMetric === metric.key ? "active" : ""
                    }`}
                >
                  <div className="metric-chart-print-title">{metric.label}</div>
                  <div className="batch-chart-graph" dir="ltr">
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart
                        data={chartDataWithAverage}
                        margin={{ top: 10, right: 16, left: 0, bottom: 8 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis
                          dataKey="day"
                          type="number"
                          domain={xDomain}
                          ticks={xTicks}
                          label={{
                            value: "ימים מהבישול",
                            position: "insideBottom",
                            offset: -4,
                            fontSize: 12,
                          }}
                        />
                        <YAxis
                          width={40}
                          domain={getYAxisDomain(chartDataWithAverage, metric.key, AVERAGE_KEY_BY_METRIC[metric.key])}
                          allowDataOverflow
                          tickCount={5}
                          tickFormatter={(v) => Number(v).toFixed(1)}
                        />
                        <Tooltip
                          content={makeTooltipRenderer(metric, chartData, styleAverages, yeastDropsByDay)}
                        />
                        <Legend
                          verticalAlign="bottom"
                          align="center"
                          wrapperStyle={{
                            paddingTop: 10,
                            direction: "rtl",
                          }}
                        />
                        <Line
                          type="monotone"
                          dataKey={metric.key}
                          name={metric.label}
                          stroke={metric.color}
                          strokeWidth={2.5}
                          dot={{ r: 4 }}
                          activeDot={{ r: 6 }}
                          connectNulls
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey={AVERAGE_KEY_BY_METRIC[metric.key]}
                          name={
                            tank.beerStyle
                              ? `ממוצע ${tank.beerStyle}`
                              : "ממוצע הסגנון"
                          }
                          stroke="#7c3aed"
                          strokeWidth={2}
                          strokeDasharray="6 4"
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />

                        {chartData
                          .filter((p) => p.yeastNote && p[metric.key] !== null)
                          .map((p) => (
                            <ReferenceDot
                              key={`yeast-${metric.key}-${p.day}`}
                              x={p.day}
                              y={p[metric.key] as number}
                              r={7}
                              fill="#058a05"
                              stroke="white"
                              strokeWidth={2}
                            />
                          ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}

            <div className="batch-chart-actions">
              <button
                type="button"
                className="status-filter-button"
                onClick={handlePrint}
              >
                🖨️ הדפסה / שמירה כ-PDF
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default BatchHistoryChart;
