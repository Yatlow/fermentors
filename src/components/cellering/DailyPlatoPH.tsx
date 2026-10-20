import { useEffect, useState } from "react";
import { cellarMeasurementWarnings } from "../../SERVICES/cellering/cellarMeasurementWarnings";
import type { Fermentor, NewReading } from "../../App";
import RecentMeasurements from "./RecentMeasurements";
import { beerStyleVisual } from "../../SERVICES/beerStyleVisual";
import { graceElapsedLabel } from "../../SERVICES/dashboard/cellarGrace";

export type DailyPlatoPHProps = {
  brews: Fermentor[],
  newReadings: Record<string, NewReading>,
  updateReading: Function,
  dailyProgress: Record<string, { temp: boolean; pressure: boolean; plato: boolean; pH: boolean }>,
}

export default function DailyPlatoPH({
  brews,
  newReadings,
  updateReading,
  dailyProgress,
}: DailyPlatoPHProps) {

  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => new Date());
  const graceStateTank = brews.find(tank => Number(tank.tankNumber) === 1);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  function normelizeInputValue(value: number, max: number, min: number) {
    if (value > max || value < min) return ""
    return value
  }
  return (
    <div className="write-messurmant">
      <div className="measurement-grid">
        {brews
          .filter((fv) => (Number(fv?.tankNumber) !== 1 && Number(fv?.currentData?.temp) > 9 && fv?.stage?.name === "בתסיסה"))
          .map((fv) => {
            const reading = newReadings[fv.id] ?? {};
            const graceLabel = graceElapsedLabel(fv, graceStateTank, now);
            const inGrace = graceLabel !== null;
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


                {Number(fv.action) === 1 && <div role="status" style={{ fontSize: "0.78rem", padding: "3px 9px", color: inGrace ? "#52687b" : dailyProgress[fv.id]?.plato && dailyProgress[fv.id]?.pH ? "#18743b" : "#866119" }}>
                  {graceLabel !== null
                    ? graceLabel
                    : dailyProgress[fv.id]?.plato && dailyProgress[fv.id]?.pH ? "✓ הושלם היום" : dailyProgress[fv.id]?.plato || dailyProgress[fv.id]?.pH ? "◐ בוצע חלקית היום" : "○ טרם בוצע היום"}
                </div>}
                <div className="measurement-batch" style={Number(fv.action) === 1 ? { borderInlineStart: `4px solid ${beerStyleVisual(fv.beerStyle).border}`, paddingInlineStart: 8 } : undefined}>
                  {Number(fv.action) === 1 ? `אצווה #${fv.batchNumber ?? "-"}` : `מיכל ${fv.stage?.name}`}
                </div>

                <div className="measurement-last">
                  <span>קריאה קודמת- </span>
                  <span>
                    <strong>
                      {fv.currentData?.plato ?? "-"}°
                    </strong>
                    {" :"}
                    Plato
                  </span>

                  <span>
                    pH:{" "}
                    <strong>
                      {fv.currentData?.pH ?? "-"}
                    </strong>
                  </span>
                </div>

                <RecentMeasurements tank={fv} mode="warm" />

                <div className="measurement-inputs">

                  <div className="measurement-input">
                    <input
                      min={0}
                      max={20}
                      type="number"
                      value={reading.plato ?? ""}
                      onBlur={() => setTouched((prev) => ({ ...prev, [`${fv.id}:plato`]: true }))}
                      placeholder={"Plato"}
                      disabled={Number(fv.action) !== 1}
                      onChange={(e) =>
                        updateReading(
                          fv.id,
                          "plato",
                          e.target.value === ""
                            ? ""
                            : normelizeInputValue(Number(e.target.value), 20, 0)
                        )
                      }
                    />
                    <span className="platoInputSpan">°</span>
                  </div>

                  <div className="measurement-input">
                    <input
                      min={0}
                      max={7}
                      type="number"
                      value={reading.pH ?? ""}
                      onBlur={() => setTouched((prev) => ({ ...prev, [`${fv.id}:pH`]: true }))}
                      placeholder={"pH"}
                      disabled={Number(fv.action) !== 1}
                      onChange={(e) =>
                        updateReading(
                          fv.id,
                          "pH",
                          e.target.value === ""
                            ? ""
                            : normelizeInputValue(Number(e.target.value), 7, 0)
                        )
                      }
                    />
                    <span>pH</span>
                  </div>

                </div>
                {touched[`${fv.id}:plato`] || touched[`${fv.id}:pH`] ? (() => {
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