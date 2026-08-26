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
  Legend,
} from "recharts";

import type { TooltipContentProps } from "recharts";
import { getMeasurementsByBatch } from "../SERVICES/gettAllDataByBatch";
import type { Measurement } from "../SERVICES/calculateCelleringRecomendations";
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
// בפורמט "YYYY-MM-DD_HHMM" (כמו ב-getMeasurementDate שכבר יש לך
// ב-calculateCelleringRecomendations.ts).
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

// ============================================================
// AXIS HELPERS
// ============================================================

// טווח X הדוק לנתונים בפועל + טיקים רק על המינימום והמקסימום
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

  return { domain: [min, max], ticks: [min, max] };
}

// טווח Y הדוק לנתונים בפועל של מדד ספציפי (כל מדד יכול לנוע בסקאלה שונה לגמרי)
function getYAxisDomain(
  data: ChartPoint[],
  key: MetricKey
): [number, number] {

  const values = data
    .map((point) => point[key])
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

  return [min, max];
}

// ============================================================
// BUILD CHART DATA
// ============================================================

function buildChartData(tank: Fermentor, measurements: Measurement[]): ChartPoint[] {
  const brewDate = parseBrewDate(tank.brewDate);

  const parsedRows = measurements
    .map((m) => ({ m, date: parseMeasurementDate(m.id) }))
    .filter((r): r is { m: Measurement; date: Date } => r.date !== null);

  parsedRows.sort((a, b) => a.date.getTime() - b.date.getTime());

  // עוגן ליום 0: תאריך הבישול אם קיים, אחרת המדידה המוקדמת ביותר
  const anchor = brewDate ?? parsedRows[0]?.date ?? null;

  const points: ChartPoint[] = parsedRows.map((row) => {
    const day = anchor ? diffDays(row.date, anchor) : 0;
    const notes =
      row.m.notes !== null && row.m.notes !== undefined ? String(row.m.notes) : "";

    // carbonation: אם השדה עדיין לא מוגדר בטיפוס Measurement המשותף,
    // הקאסט הבטוח הזה מונע שגיאת TS. כדאי בהמשך להוסיף
    // carbonation?: number | string | null; לטיפוס Measurement המקורי.
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

  // Starting Plato -> יום 0. משמש כשאין עדיין מדידת פלאטו בפועל ביום 0.
  // (הנחה: יש שדה tank.startingPlato - אם השם אצלך שונה, עדכן כאן)
  const startingPlato = toNumberOrNull(tank.startingPlato);
  if (startingPlato !== null) {
    const dayZero = points.find((p) => p.day === 0);
    if (dayZero) {
      if (dayZero.plato === null) dayZero.plato = startingPlato;
    } else {
      points.unshift({
        day: 0,
        dateLabel: brewDate ? brewDate.toLocaleDateString("he-IL") : "",
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
// TOOLTIP
// נבנה כ-content מותאם אישית (במקום formatter/labelFormatter)
// כדי לעקוף את הטיפוס הגנרי הבעייתי של recharts (Formatter<ValueType,...>
// לא כולל null, וזה מה שגרם לשגיאת ה-TS בגרסה הקודמת).
// ============================================================

function makeTooltipRenderer(
  metric: (typeof METRICS)[number],
  chartData: ChartPoint[],
  styleAverages: StyleAverages | null
) {
  return function TooltipRenderer({ active, label, payload }: TooltipContentProps) {
    if (!active || !payload || payload.length === 0 || label === undefined) {
      return null;
    }

    const dayNumber = Number(label);
    const point = chartData.find((p) => p.day === dayNumber);
    const dayInfo = styleAverages?.days?.[String(dayNumber)];

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
      </div>
    );
  };
}

// ============================================================
// COMPONENT
// ============================================================

function BatchHistoryChart({ tank, onClose }: BatchHistoryChartProps) {
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeMetric, setActiveMetric] = useState<MetricKey>("plato");
  const [styleAverages, setStyleAverages] =
    useState<StyleAverages | null>(null);


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

  const chartData = useMemo(
    () => buildChartData(tank, measurements),
    [tank, measurements]
  );

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

        // לא להציג ממוצע מעבר ליום האחרון
        // שהאצווה הנוכחית באמת הגיעה אליו
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
          existing.averagePlato =
            values.plato ?? null;

          existing.averagePH =
            values.pH ?? null;

          existing.averageTemp =
            values.temp ?? null;

          existing.averagePressure =
            values.pressure ?? null;

          existing.averageCarbonation =
            values.carbonation ?? null;
        } else {
          result.push({
            day,
            dateLabel: "",
            plato: null,
            pH: null,
            temp: null,
            pressure: null,
            carbonation: null,

            averagePlato:
              values.plato ?? null,

            averagePH:
              values.pH ?? null,

            averageTemp:
              values.temp ?? null,

            averagePressure:
              values.pressure ?? null,

            averageCarbonation:
              values.carbonation ?? null,

            yeastNote: null,
          });
        }
      }
    );

    return result.sort(
      (a, b) => a.day - b.day
    );
  }, [chartData, styleAverages]);


  const yeastNotes = useMemo(
    () => chartData.filter((p) => p.yeastNote),
    [chartData]
  );

  function handlePrint() {
    window.print();
  }

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
            {/* טאבים - נוח במיוחד למובייל: גרף אחד בכל פעם במקום כמה צירים על מסך קטן */}
            <div className="chart-metric-tabs">
              {METRICS.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  className={`chart-metric-tab ${activeMetric === metric.key ? "active" : ""
                    }`}
                  onClick={() => setActiveMetric(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
            </div>

            {/*
              כל הגרפים נשארים ב-DOM (מוסתרים ב-CSS) ולא רק זה הפעיל.
              זה מה שמאפשר שבהדפסה / "שמירה כ-PDF" (window.print) יודפס
              דוח מלא עם כל המדדים אחד מתחת לשני, ולא רק מה שרואים במסך.
              לכל מדד טווח X משלו - מחושב רק מהימים שבהם יש בפועל מדידה
              לאותו מדד ספציפית (לא נמתח עד לימי הממוצע הכלליים).
            */}
            {METRICS.map((metric) => {

              const metricDays = chartData
                .filter((p) => p[metric.key] !== null && p[metric.key] !== undefined)
                .map((p) => p.day);

              const { domain: xDomain, ticks: xTicks } = getXAxisBounds(metricDays);

              return (
                <div
                  key={metric.key}
                  className={`metric-chart-block ${activeMetric === metric.key ? "active" : ""
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
                        <YAxis width={40} domain={getYAxisDomain(chartDataWithAverage, metric.key)} />
                        <Tooltip content={makeTooltipRenderer(metric, chartData, styleAverages)} />
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

            {yeastNotes.length > 0 && (
              <div className="chart-notes-list">
                <div className="chart-notes-title">🟢 שמרים</div>
                {yeastNotes.map((n) => (
                  <div key={`note-${n.day}`} className="chart-note-row">
                    <span className="chart-note-day">יום {n.day}</span>
                    <span className="chart-note-text">{n.yeastNote}</span>
                  </div>
                ))}
              </div>
            )}

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