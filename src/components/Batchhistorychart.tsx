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
} from "recharts";

import type { TooltipContentProps } from "recharts";
import { getMeasurementsByBatch } from "../SERVICES/gettAllDataByBatch";
import type { Measurement } from "../SERVICES/calculateCelleringRecomendations";
import type { Fermentor } from "../App";

// ============================================================
// TYPES
// ============================================================

type BatchHistoryChartProps = {
  tank: Fermentor;
  onClose: () => void;
};

type MetricKey = "plato" | "pH" | "temp" | "pressure";

type ChartPoint = {
  day: number;
  dateLabel: string;
  plato: number | null;
  pH: number | null;
  temp: number | null;
  pressure: number | null;
  yeastNote: string | null;
};

const METRICS: {
  key: MetricKey;
  label: string;
  unit: string;
  color: string;
}[] = [
  { key: "plato", label: "סוכר (Plato)", unit: "°P", color: "#d99323" },
  { key: "pH", label: "pH", unit: "", color: "#5b8def" },
  { key: "temp", label: "טמפ׳", unit: "°C", color: "#e0563f" },
  { key: "pressure", label: "לחץ", unit: "bar", color: "#3fa796" },
];

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
    return {
      day,
      dateLabel: row.date.toLocaleDateString("he-IL"),
      plato: toNumberOrNull(row.m.plato),
      pH: toNumberOrNull(row.m.pH),
      temp: toNumberOrNull(row.m.temp),
      pressure: toNumberOrNull(row.m.pressure),
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
  chartData: ChartPoint[]
) {
  return function TooltipRenderer({
    active,
    label,
    payload,
  }: TooltipContentProps) {
    if (!active || !payload || payload.length === 0 || label === undefined) {
      return null;
    }

    const dayNumber = Number(label);
    const raw = payload[0]?.value;

    const point = chartData.find((p) => p.day === dayNumber);

    const text =
      raw === null || raw === undefined || raw === ""
        ? "—"
        : `${raw}${metric.unit}`;

    return (
      <div className="chart-tooltip">
        <div className="chart-tooltip-day">
          יום {dayNumber}
          {point?.dateLabel ? ` (${point.dateLabel})` : ""}
        </div>

        <div className="chart-tooltip-value">
          {text}
        </div>
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

  const chartData = useMemo(
    () => buildChartData(tank, measurements),
    [tank, measurements]
  );

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
            {/* טאבים - נוח במיוחד למובייל: גרף אחד בכל פעם במקום 4 צירים על מסך קטן */}
            <div className="chart-metric-tabs">
              {METRICS.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  className={`chart-metric-tab ${
                    activeMetric === metric.key ? "active" : ""
                  }`}
                  onClick={() => setActiveMetric(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
            </div>

            {/*
              כל ה-4 גרפים נשארים ב-DOM (מוסתרים ב-CSS) ולא רק זה הפעיל.
              זה מה שמאפשר שבהדפסה / "שמירה כ-PDF" (window.print) יודפס
              דוח מלא עם כל 4 המדדים אחד מתחת לשני, ולא רק מה שרואים במסך.
            */}
            {METRICS.map((metric) => (
              <div
                key={metric.key}
                className={`metric-chart-block ${
                  activeMetric === metric.key ? "active" : ""
                }`}
              >
                <div className="metric-chart-print-title">{metric.label}</div>
                <div className="batch-chart-graph" dir="ltr">
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart
                      data={chartData}
                      margin={{ top: 10, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis
                        dataKey="day"
                        label={{
                          value: "ימים מהבישול",
                          position: "insideBottom",
                          offset: -4,
                          fontSize: 12,
                        }}
                      />
                      <YAxis width={40} domain={["auto", "auto"]} />
                      <Tooltip content={makeTooltipRenderer(metric, chartData)} />
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
            ))}

            {yeastNotes.length > 0 && (
              <div className="chart-notes-list">
                <div className="chart-notes-title">🟣 הערות שמרים</div>
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
