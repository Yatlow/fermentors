import { useState } from "react";
import { cellarMeasurementWarnings } from "../../SERVICES/cellering/cellarMeasurementWarnings";
import type { Fermentor, NewReading } from "../../App";
import RecentMeasurements from "./RecentMeasurements";
import { beerStyleVisual } from "../../SERVICES/beerStyleVisual";

export type DailyPressureAndTempProps = {
  brews: Fermentor[],
  newReadings: Record<string, NewReading>,
  updateReading: Function,
}

export default function DailyPressureAndTemp({
  brews,
  newReadings,
  updateReading,
}: DailyPressureAndTempProps) {

  const [touched, setTouched] = useState<Record<string, boolean>>({});
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

                <RecentMeasurements tank={fv} mode="pressure" />

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