import { useState } from "react";
import { cellarMeasurementWarnings } from "../../SERVICES/cellering/cellarMeasurementWarnings";
import type { Fermentor, NewReading } from "../../App";
import RecentMeasurements from "./RecentMeasurements";
import { beerStyleVisual } from "../../SERVICES/beerStyleVisual";

export type DailyPlatoPHProps = {
  brews: Fermentor[],
  newReadings: Record<string, NewReading>,
  updateReading: Function,
}

export default function DailyPlatoPH({
  brews,
  newReadings,
  updateReading,
}: DailyPlatoPHProps) {

  const [touched, setTouched] = useState<Record<string, boolean>>({});
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
                  const warnings = cellarMeasurementWarnings(fv.tankNumber ?? fv.id, reading, fv.currentData ?? {}, { brewAge: 3 });
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