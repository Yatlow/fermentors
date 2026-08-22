import type { Fermentor, NewReading } from "../App";

export type DailyPressureAndTempProps={
    brews:Fermentor[],
    newReadings:Record<string, NewReading>,
    updateReading:Function,
}

 export default function DailyPressureAndTemp({
    brews,
    newReadings,
    updateReading,
 }:DailyPressureAndTempProps){

    function normelizeInputValue(value:number,max:number,min:number){
        if (value>max || value<min) return ""
        return value
    }

    return(
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
                            <div className="measurement-style">
                              {fv.beerStyle ?? "-"}
                            </div>}
                        </div>


                        <div className="measurement-batch">
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

                        <div className="measurement-inputs">

                          <div className="measurement-input">
                            <input
                              min={0}
                              max={100}
                              type="number"
                              value={reading.temp ?? ""}
                              placeholder={Number(fv.action) !== 1 ? "  /" : "טמפ׳"}
                              disabled={Number(fv.action) !== 1}
                              onChange={(e) =>
                                updateReading(
                                  fv.id,
                                  "temp",
                                  normelizeInputValue(Number(e.target.value),100,0)
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
                              placeholder={Number(fv.action) !== 1 ? "  /" : "לחץ"}
                              disabled={Number(fv.action) !== 1}
                              onChange={(e) =>
                                updateReading(
                                  fv.id,
                                  "pressure",
                                  normelizeInputValue(Number(e.target.value),2.5,0)
                                )
                              }
                            />
                            <span>bar</span>
                          </div>

                        </div>

                      </div>
                    );
                  })}
              </div>
            </div>
    )
 }