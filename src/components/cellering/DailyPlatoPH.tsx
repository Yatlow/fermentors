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

              </div>
            );
          })}
      </div>
    </div>
  )
}