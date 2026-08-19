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

type StatusCounts = Record<string, number>;

// ============================================================
// APP
// ============================================================

function App() {
  const [brews, setBrews] =
    useState<Fermentor[]>([]);

  const [loading, setLoading] =
    useState<boolean>(true);

  const [selectedStatuses, setSelectedStatuses] =
    useState<string[]>(["הכל"]);

  const [selectedStyles, setSelectedStyles] =
    useState<string[]>(["הכל"]);
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

  console.log(
  "ACTION 4 TANKS:",
  brews.filter(
    (tank) => Number(tank.action) === 4
  )
);
console.log(
  "FILTERED:",
  filteredBrews.map(tank => ({
    id: tank.id,
    uid: tank.uid,
    tankNumber: tank.tankNumber,
    action: tank.action,
    beerStyle: tank.beerStyle
  }))
);

  const totalTanks = brews.filter(
    (tank) => Number(tank.tankNumber) !== 1
  ).length;
  const filteredTankCount = filteredBrews.length;
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
    <div className="dashboard">

      {/* HEADER */}

      <header className="dashboard-header">

        <div className="headerBox">

          <div className="header-brand">

            <img
              src={shpiro}
              alt="Shpiro"
              className="header-logo"
            />

            <div>
              <h1 className="dashboard-title">
                🍺 Fermenter Dashboard
              </h1>
            </div>

          </div>


          {/* STATUS FILTER */}

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

        </div>

      </header>


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

    </div>
  );
}

export default App;