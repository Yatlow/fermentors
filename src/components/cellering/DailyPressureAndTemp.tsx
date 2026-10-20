import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, History } from "lucide-react";
import { getMeasurementsByBatch, MEASUREMENTS_UPDATED_EVENT } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import { yesterdayActionNotes } from "../../SERVICES/cellering/yesterdayActionNotes";
import { cellarMeasurementWarnings } from "../../SERVICES/cellering/cellarMeasurementWarnings";
import type { Fermentor, NewReading } from "../../App";
import RecentMeasurements from "./RecentMeasurements";
import { beerStyleVisual } from "../../SERVICES/beerStyleVisual";
import { elapsedFermentationHours, isInMeasurementGrace } from "../../SERVICES/dashboard/cellarGrace";

export type DailyPressureAndTempProps = {
  brews: Fermentor[],
  newReadings: Record<string, NewReading>,
  updateReading: Function,
  dailyProgress: Record<string, { temp: boolean; pressure: boolean; plato: boolean; pH: boolean }>,
}

export default function DailyPressureAndTemp({
  brews,
  newReadings,
  updateReading,
  dailyProgress,
}: DailyPressureAndTempProps) {

  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => new Date());
  const graceStateTank = brews.find(tank => Number(tank.tankNumber) === 1);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [yesterdayActions, setYesterdayActions] = useState<Record<string, string[]>>({});
  const [expandedActionTanks, setExpandedActionTanks] = useState<Record<string, boolean>>({});

  // Reuse the existing measurement cache and its compact cellarState snapshot.
  const activeBatches = brews
    .filter(tank => Number(tank.action) === 1 && tank.batchNumber != null)
    .map(tank => `${tank.id}:${String(tank.batchNumber).replace("#", "").trim()}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
      const results = await Promise.all(
        activeBatches.split("|").filter(Boolean).map(async entry => {
          const separator = entry.indexOf(":");
          const id = entry.slice(0, separator);
          const batch = entry.slice(separator + 1);
          try {
            const rows = await getMeasurementsByBatch(batch);
            return [id, yesterdayActionNotes(rows, dateKey)] as const;
          } catch {
            return [id, []] as const;
          }
        })
      );
      if (!cancelled) setYesterdayActions(Object.fromEntries(results));
    }
    void refresh();
    const updated = () => { void refresh(); };
    window.addEventListener(MEASUREMENTS_UPDATED_EVENT, updated);
    return () => {
      cancelled = true;
      window.removeEventListener(MEASUREMENTS_UPDATED_EVENT, updated);
    };
  }, [activeBatches]);

  function normelizeInputValue(value: number, max: number, min: number) {
    if (value > max || value < min) return ""
    return value
  }

  return (
    <div className="write-messurmant">
      <div className="measurement-grid">
        {brews
          .filter((fv) => Number(fv.tankNumber) !== 1)
          .map((fv) => {
            const reading = newReadings[fv.id] ?? {};
            const inGrace = Number(fv.action) === 1 && isInMeasurementGrace(fv, graceStateTank, now);
            const elapsedHours = inGrace ? elapsedFermentationHours(fv, now) : null;
            const stageClass = fv.stage?.className ?? "";
            return (
              <div className={`measurement-card ${stageClass}`} key={fv.id}>
                <div className="measurement-header">
                  <div className="measurement-tank">
                    מיכל {fv.tankNumber}
                  </div>
                  {Number(fv.action) === 1 &&
                    <div className="measurement-style" style={{ background: beerStyleVisual(fv.beerStyle).background, borderColor: beerStyleVisual(fv.beerStyle).border, color: beerStyleVisual(fv.beerStyle).text }}>
                      {fv.beerStyle ?? "-"}
                    </div>}
                </div>


                {Number(fv.action) === 1 && <div role="status" style={{ fontSize: "0.78rem", padding: "3px 9px", color: inGrace ? "#52687b" : dailyProgress[fv.id]?.temp && dailyProgress[fv.id]?.pressure ? "#18743b" : "#866119" }}>
                  {inGrace && elapsedHours !== null
                    ? `עברו ${elapsedHours} שעות מהעברה למיכל`
                    : dailyProgress[fv.id]?.temp && dailyProgress[fv.id]?.pressure ? "✓ הושלם היום" : dailyProgress[fv.id]?.temp || dailyProgress[fv.id]?.pressure ? "◐ בוצע חלקית היום" : "○ טרם בוצע היום"}
                </div>}
                <div className="measurement-batch" style={Number(fv.action) === 1 ? { borderInlineStart: `4px solid ${beerStyleVisual(fv.beerStyle).border}`, paddingInlineStart: 8 } : undefined}>
                  {Number(fv.action) === 1 ? `אצווה #${fv.batchNumber ?? "-"}` : `מיכל ${fv.stage?.name}`}
                </div>

                <div className="measurement-last">
                  <span>קריאה קודמת- </span>
                  <span>
                    טמפ׳:{" "}
                    <strong>
                      {Number(fv.action) === 1 ? fv.currentData?.temp ?? "-" : "-"}°
                    </strong>
                  </span>

                  <span>
                    לחץ:{" "}
                    <strong>
                      {Number(fv.action) === 1 ? fv.currentData?.pressure ?? "-" : "-"}
                    </strong>
                  </span>
                </div>

                <div style={{ height: "3.2rem", display: "flex", alignItems: "center", overflow: "hidden" }}>
                  {Number(fv.action) === 1 && (yesterdayActions[fv.id]?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      aria-label={`פעולות אתמול במיכל ${fv.tankNumber ?? fv.id}. לחץ לפתיחה או סגירה של הפירוט`}
                      aria-expanded={Boolean(expandedActionTanks[fv.id])}
                      onClick={() => setExpandedActionTanks(prev => ({ ...prev, [fv.id]: !prev[fv.id] }))}
                      title={`אתמול: ${yesterdayActions[fv.id].join(" · ")}`}
                      style={{
                        display: "flex", alignItems: "center", gap: 6, width: "100%",
                        margin: "3px 9px", padding: "2px 0", border: "none",
                        background: "transparent", color: "#52687b", fontSize: "0.76rem",
                        lineHeight: 1.35, textAlign: "right", cursor: "pointer",
                      }}
                    >
                      <History size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
                      <span style={{
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                        overflow: "hidden", overflowWrap: "anywhere", flex: 1,
                      }}>אתמול: {yesterdayActions[fv.id].join(" · ")}</span>
                      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, fontSize: "0.7rem", color: "#356e9b" }}>
                        {expandedActionTanks[fv.id] ? "סגור" : "פירוט"}
                        {expandedActionTanks[fv.id] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </span>
                    </button>
                  )}
                </div>

                <div className="measurement-inputs">

                  <div className="measurement-input">
                    <input
                      min={0}
                      max={100}
                      type="number"
                      value={reading.temp ?? ""}
                      onBlur={() => setTouched((prev) => ({ ...prev, [`${fv.id}:temp`]: true }))}
                      placeholder={Number(fv.action) !== 1 ? "  /" : "טמפ׳"}
                      disabled={Number(fv.action) !== 1}
                      onChange={(e) =>
                        updateReading(
                          fv.id,
                          "temp",
                          e.target.value === ""
                            ? ""
                            : normelizeInputValue(Number(e.target.value), 100, 0)
                        )
                      }
                    />
                    <span>°</span>
                  </div>

                  <div className="measurement-input">
                    <input
                      min={0}
                      max={3}
                      type="number"
                      value={reading.pressure ?? ""}
                      onBlur={() => setTouched((prev) => ({ ...prev, [`${fv.id}:pressure`]: true }))}
                      placeholder={Number(fv.action) !== 1 ? "  /" : "לחץ"}
                      disabled={Number(fv.action) !== 1}
                      onChange={(e) =>
                        updateReading(
                          fv.id,
                          "pressure",
                          e.target.value === ""
                            ? ""
                            : normelizeInputValue(Number(e.target.value), 2.5, 0)
                        )
                      }
                    />
                    <span>bar</span>
                  </div>

                </div>
                {expandedActionTanks[fv.id] && (yesterdayActions[fv.id]?.length ?? 0) > 0 && (
                  <div role="region" aria-label="כל הפעולות מאתמול" style={{
                    padding: "6px 10px", margin: "4px 8px 6px", borderRadius: 6,
                    background: "rgba(255,255,255,0.72)", color: "#52687b",
                    fontSize: "0.8rem", lineHeight: 1.6,
                  }}>
                    <strong>אתמול:</strong>
                    {yesterdayActions[fv.id].map((action, index) => <div key={index}>• {action}</div>)}
                  </div>
                )}
                <RecentMeasurements tank={fv} mode="pressure" />

                {touched[`${fv.id}:temp`] || touched[`${fv.id}:pressure`] ? (() => {
                  const warnings = cellarMeasurementWarnings(fv.tankNumber ?? fv.id, reading, fv.currentData ?? {}, { brewAge: 0 });
                  const relevant = warnings.filter((warning) => {
                    if (/ללא (לחץ|טמפרטורה|pH|פלאטו)/.test(warning)) return false;
                    if (/ירידת לחץ|עליית לחץ/.test(warning)) return false; // Action history is checked at submit.
                    if (/שינוי טמפרטורה/.test(warning) && Number(reading.temp) < Number(fv.currentData?.temp)) return false; // Cooling action is checked at submit.
                    return true;
                  });
                  return relevant.length > 0 ? <div role="status" style={{ color: "#9a5b00", fontSize: "0.85rem", padding: "6px 10px" }}>{relevant.map((warning, index) => <div key={index}>⚠ {warning}</div>)}</div> : null;
                })() : null}

              </div>
            );
          })}
      </div>
    </div>
  )
}