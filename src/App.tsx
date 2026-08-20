import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import { getTankStage } from "./SERVICES/tankstage"
import TankCard from "./components/TankCard";

import "./App.css";
import shpiro from "./assets/shpiro.jpeg";
import { writeReadingsToSheets } from "./SERVICES/writeReadingToSheets";
import {
  getSpecsFromFb,
  type SpecChart
} from "../src/SERVICES/getSpecsFromFb";


// ============================================================
// TYPES
// ============================================================

export type FirestoreTimestamp = {
  seconds?: number;
  nanoseconds?: number;
  toDate?: () => Date;
};

export type Fermentor = {
  id: string;

  uid?: string | number | null;

  tankNumber?: string | number | null;

  action?: string | number | null;

  batchNumber?: string | number | null;

  beerStyle?: string | null;

  brewDate?: string | null;

  pasivationDate?:
  | string
  | Date
  | FirestoreTimestamp
  | null;

  beerVolume?: string | number | null;

  sheetUrl?: string | null;

  currentData?: {
    temp?: string | number | null;
    plato?: string | number | null;
    pH?: string | number | null;
    pressure?: string | number | null;
    carbonation?: string | number | null;
    volume?: string | number | null;
  } | null;

  [key: string]: unknown;
};

type NewReading = {
  temp?: string | number | null;
  plato?: string | number | null;
  pH?: string | number | null;
  pressure?: string | number | null;
  carbonation?: string | number | null;
  volume?: string | number | null;
  notes?: string | null;
};
export type ReadingToSend = NewReading & {
  tankId: string;
  sheetUrl?: string | null;
};
type StatusCounts = Record<string, number>;

function App() {
  const [brews, setBrews] =
    useState<Fermentor[]>([]);

  const [loading, setLoading] =
    useState<boolean>(true);

  const [selectedView, setSelectedView] =
    useState<string>("דאשבורד");

  const [selectedStatuses, setSelectedStatuses] =
    useState<string[]>(["הכל"]);

  const [selectedStyles, setSelectedStyles] =
    useState<string[]>(["הכל"]);

  const [selectedWrites, setSelectedWrites] =
    useState<string>("לחץ");

  const [newReadings, setNewReadings] =
    useState<Record<string, NewReading>>({});

  const [specs, setSpecs] = useState<SpecChart | null>(null);

  // ==========================================================
  // LOAD FERMENTORS
  // ==========================================================
  useEffect(() => {
    const fermentorsRef = collection(db, "fermentors");

    const unsubscribe = onSnapshot(
      fermentorsRef,
      (snapshot) => {
        const data: Fermentor[] = snapshot.docs.map(
          (firebaseDoc) => {
            const firestoreData = firebaseDoc.data();

            return {
              ...(firestoreData as Record<string, unknown>),
              id: firebaseDoc.id,
            } as Fermentor;
          }
        );

        data.sort((a, b) => {
          const numA =
            parseInt(
              String(a.uid ?? "").replace(/\D/g, ""),
              10
            ) || 0;

          const numB =
            parseInt(
              String(b.uid ?? "").replace(/\D/g, ""),
              10
            ) || 0;

          return numA - numB;
        });

        setBrews(data);
        setLoading(false);
      },
      (error) => {
        console.error("Firestore listener error:", error);
        setLoading(false);
      }
    );

    // Important: remove the Firestore listener
    // when the component is unmounted.
    return () => unsubscribe();
  }, []);
  useEffect(() => {

    async function loadSpecs() {

      try {

        const data = await getSpecsFromFb();

        setSpecs(data);

      } catch (error) {

        console.error(
          "Failed to load specs:",
          error
        );

      }

    }

    loadSpecs();

  }, []);

  // ==========================================================
  // UPDATE PASIVATION DATE
  // ==========================================================

  const handleUpdatePasivation = async (
    tankId: string,
    newDate: string
  ): Promise<void> => {
    try {
      const tankRef = doc(
        db,
        "fermentors",
        tankId
      );

      await updateDoc(tankRef, {
        pasivationDate: newDate,
      });
    } catch (error) {
      console.error(
        "Error updating pasivation date:",
        error
      );
    }
  };

  const handleStyleToggle = (style: string): void => {
    if (style === "הכל") {
      setSelectedStyles(["הכל"]);
      return;
    }

    setSelectedStyles((prev) => {
      let nextState = prev.includes("הכל")
        ? []
        : [...prev];

      if (nextState.includes(style)) {
        nextState = nextState.filter(
          (s) => s !== style
        );
      } else {
        nextState.push(style);
      }

      return nextState.length === 0
        ? ["הכל"]
        : nextState;
    });
  };
  // ==========================================================
  // STATUS COUNTS
  // ==========================================================

  const statusCounts =
    useMemo<StatusCounts>(() => {
      const counts: StatusCounts = {};

      brews.forEach((tank) => {
        /*
         * tankstage.ts has its own Tank type.
         * The actual Firebase object is compatible at runtime.
         */
        if (Number(tank.tankNumber) === 1) {
          return;
        }
        const stageInfo =
          getTankStage(
            tank as Parameters<
              typeof getTankStage
            >[0]
          );

        const status =
          stageInfo?.name ||
          "לא ידוע";

        counts[status] =
          (counts[status] || 0) + 1;
      });

      return counts;
    }, [brews]);



  // ==========================================================
  // STATUS ORDER
  // ==========================================================

  const statuses =
    useMemo<string[]>(() => {
      const order = [
        "בישול חדש",
        "בתסיסה",
        "קר",
        "מלוכלך",
        "נקי",
        "מחוטא",
      ];

      const existingStatuses =
        Object.keys(statusCounts);

      return [
        ...order.filter((status) =>
          existingStatuses.includes(
            status
          )
        ),

        ...existingStatuses.filter(
          (status) =>
            !order.includes(status)
        ),
      ];
    }, [statusCounts]);




  // ==========================================================
  // STATUS FILTER
  // ==========================================================



  const handleStatusToggle = (
    status: string
  ): void => {
    if (status === "הכל") {
      setSelectedStatuses(["הכל"]);
      return;
    }

    setSelectedStatuses((prev) => {
      let nextState =
        prev.includes("הכל")
          ? []
          : [...prev];

      if (
        nextState.includes(status)
      ) {
        nextState =
          nextState.filter(
            (s) => s !== status
          );
      } else {
        nextState.push(status);
      }

      return nextState.length === 0
        ? ["הכל"]
        : nextState;
    });
  };

  const updateReading = (
    tankId: string,
    field: keyof NewReading,
    value: string
  ) => {
    setNewReadings((prev) => ({
      ...prev,
      [tankId]: {
        ...prev[tankId],
        [field]: value,
      },
    }));
  };
  const handleSendReadings = async () => {
    const readingsToSend = brews
      .filter((fv) => Number(fv.tankNumber) !== 1)
      .map((fv) => {
        const reading = newReadings[fv.id] ?? {};

        return {
          tankId: fv.id,
          ...reading,
          sheetUrl: fv.sheetUrl ?? null,
        };
      })
      .filter(
        (reading) =>
          reading.temp !== undefined ||
          reading.pressure !== undefined ||
          reading.pH !== undefined ||
          reading.plato !== undefined ||
          reading.carbonation !== undefined ||
          reading.notes !== undefined
      );
    // console.log(readingsToSend)
    try {
      await writeReadingsToSheets(readingsToSend);

      setNewReadings({});
    } catch (error) {
      console.error("Failed to send readings:", error);
    } setNewReadings({})

  }
  // ==========================================================
  // FILTERED TANKS
  // ==========================================================
  const totalVolumes = useMemo<Record<string, number>>(() => {
    const vols: Record<string, number> = {};

    brews.forEach((brew) => {
      const style = String(brew.beerStyle ?? "");
      const volume = Number(brew.beerVolume ?? 0);

      if (!style) return;
      if (Number(brew.action) > 2) return;
      vols[style] = (vols[style] || 0) + volume;
    });
    return vols;
  }, [brews]);

  const filteredBrews = useMemo<Fermentor[]>(() => {
    return brews.filter((tank) => {

      // מיכל 1 מוצג רק כאשר לא נבחר שום פילטר
      if (Number(tank.tankNumber) === 1) {
        return (
          selectedStatuses.includes("הכל") &&
          selectedStyles.includes("הכל")
        );
      }

      // ========================================================
      // STATUS
      // ========================================================

      const stageInfo = getTankStage(
        tank as Parameters<typeof getTankStage>[0]
      );

      const matchesStatus =
        selectedStatuses.includes("הכל") ||
        (
          stageInfo?.name !== undefined &&
          selectedStatuses.includes(stageInfo.name)
        );

      // ========================================================
      // STYLE
      // ========================================================

      const style = String(
        tank.beerStyle ?? ""
      ).trim();

      const matchesStyle =
        selectedStyles.includes("הכל") ||
        selectedStyles.includes(style);

      return matchesStatus && matchesStyle;
    });
  }, [
    brews,
    selectedStatuses,
    selectedStyles,
  ]);

  const totalTanks = brews.filter(
    (tank) => Number(tank.tankNumber) !== 1
  ).length;
  const filteredTankCount =
    filteredBrews.filter(
      (tank) => Number(tank.tankNumber) !== 1
    ).length;
  // ==========================================================
  // LOADING
  // ==========================================================
  if (loading) {
    return (
      <div className="dashboard-loading">
        <h1>
          טוען נתונים...
        </h1>
      </div>
    );
  }

  // ==========================================================
  // RENDER
  // ==========================================================

  return (
    <div>
      <header className="dashboard-header">

        <div className="headerBox">

          <div className="header-brand">

            <img
              src={shpiro}
              alt="Shpiro"
              className="header-logo"
            />

            <div className="views-box">
              <div className={`views-item ${selectedView === "דאשבורד"
                ? "active" : ""}`}
                onClick={() => setSelectedView("דאשבורד")}
              >
                דאשבורד
              </div>
              <div className={`views-item ${selectedView === "רישום"
                ? "active" : ""}`}
                onClick={() => setSelectedView("רישום")}
              >
                רישום פעולות סלרינג
              </div>
              <div className={`views-item ${selectedView === "דוחות"
                ? "active" : ""}`}
                onClick={() => setSelectedView("דוחות")}
              >
                דוחות
              </div>
              <div className={`views-item ${selectedView === "ניהול" ?
                "active" : ""}`}
                onClick={() => setSelectedView("ניהול")}
              >
                פעולות ניהול
              </div>
            </div>
          </div>


          {selectedView === "דאשבורד" &&
            <div className="status-filter">

              <button
                type="button"
                className={`status-filter-button ${selectedStatuses.includes(
                  "הכל"
                )
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  handleStatusToggle(
                    "הכל"
                  )
                }
              >

                <span>
                  הכל
                </span>

                <span className="status-filter-count">
                  {totalTanks}
                </span>

              </button>


              {statuses.map(
                (status) => (

                  <button
                    key={status}
                    type="button"
                    className={`status-filter-button ${selectedStatuses.includes(
                      status
                    )
                      ? "active"
                      : ""
                      }`}
                    onClick={() =>
                      handleStatusToggle(
                        status
                      )
                    }
                  >

                    <span>
                      {status}
                    </span>

                    <span className="status-filter-count">
                      {
                        statusCounts[
                        status
                        ]
                      }
                    </span>

                  </button>

                )
              )}

            </div>
          }


          {selectedView === "רישום" &&
            <div className="status-filter">
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "לחץ"
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  setSelectedWrites(
                    "לחץ"
                  )
                }
              >
                <span>
                  סבב יומי- טמפ' ולחץ
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "חם"
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  setSelectedWrites(
                    "חם"
                  )
                }
              >
                <span>
                  בדיקות סוכר וpH למיכלים חמים
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "אריזה"
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  setSelectedWrites(
                    "אריזה"
                  )
                }
              >
                <span>
                  דיווח אריזה
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "פעולות"
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  setSelectedWrites(
                    "פעולות"
                  )
                }
              >
                <span>
                  דיווח פעולות סלרינג
                </span>
              </button>
            </div>
          }

        </div>

      </header>
      {selectedView === "דאשבורד" &&
        <div className="dashboard">




          {/* FILTER INFO */}

          <div className="dashboard-filter-info">

            <span>
              מציג מסננים:
            </span>

            <strong>
              {selectedStatuses.includes(
                "הכל"
              )
                ? "הכל"
                : selectedStatuses.join(
                  ", "
                )}
            </strong>

            <span className="filter-count-badge">
              · {filteredTankCount} מיכלים
            </span>

          </div>
          <div className="volumeCounter">

            <span>
              סיכום נפחים במיכלים:
            </span>

            {Object.entries(totalVolumes).map(
              ([style, volume]) => (
                <div
                  key={style}
                  className={`volume-filter ${selectedStyles.includes(style)
                    ? "active"
                    : ""
                    }`}
                  onClick={() =>
                    handleStyleToggle(style)
                  }
                >
                  <span>{style}:</span>{" "}
                  {volume} ל'
                </div>
              )
            )}

            <div
              className={`totalVolume ${selectedStyles.includes("הכל")
                ? "active"
                : ""
                }`}
              onClick={() =>
                handleStyleToggle("הכל")
              }
            >
              סה״כ:{" "}
              {Object.values(totalVolumes).reduce(
                (total, volume) => total + volume,
                0
              )}{" "}
              ל'
            </div>

          </div>

          {/* TANK GRID */}

          <div className="tank-grid">

            {filteredBrews.map(
              (fermentor) => (

                <TankCard
                  key={fermentor.id}
                  tank={fermentor}
                  onUpdatePasivation={
                    handleUpdatePasivation
                  }
                  specs={specs}
                />

              )
            )}

          </div>


          {/* NO RESULTS */}

          {filteredBrews.length ===
            0 && (

              <div className="no-tanks">

                <p>
                  אין מיכלים העונים על
                  הסינון שנבחר
                </p>

              </div>

            )}

        </div>}

      {selectedView === "רישום" &&
        <>
          <div className="volumeCounter">
            <div className="send-messurment"
              onClick={() => handleSendReadings()}
            >
              שלח נתוני מדידה
            </div>

          </div>

          {selectedWrites === "לחץ" && (
            <div className="write-messurmant">
              <div className="measurement-grid">
                {brews
                  .filter((fv) => Number(fv.tankNumber) !== 1)
                  .map((fv) => {
                    const reading = newReadings[fv.id] ?? {};
                    const stageInfo = getTankStage(
                      fv as Parameters<typeof getTankStage>[0]
                    );
                    const stageClass = stageInfo?.className ?? "";
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
                          {Number(fv.action) === 1 ? `אצווה #${fv.batchNumber ?? "-"}` : `מיכל ${stageInfo.name}`}
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
                                  e.target.value
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
                                  e.target.value
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
          )}
          {selectedWrites === "חם" &&
            <div className="write-messurmant">
              סוכר וPH
            </div>
          }
          {selectedWrites === "פעולות" &&
            <div className="write-messurmant">
              גיזוז.שמרים.העלאת.הורדת.לחץ.דיאציטיל.כיוון פורק
            </div>
          };
        </>
      }
    </div>
  );
}

export default App;