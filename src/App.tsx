import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import { getTankStage } from "./tankstage";
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

      vols[style] = (vols[style] || 0) + volume;
    });
    return vols;
  }, [brews]);

  const filteredBrews =
    useMemo<Fermentor[]>(() => {
      if (
        selectedStatuses.includes(
          "הכל"
        )
      ) {
        return brews;
      }

      return brews.filter((tank) => {
        const stageInfo =
          getTankStage(
            tank as Parameters<
              typeof getTankStage
            >[0]
          );

        return (
          stageInfo?.name !== undefined &&
          selectedStatuses.includes(
            stageInfo.name
          )
        );
      });
    }, [
      brews,
      selectedStatuses,
    ]);

  const totalTanks =
    brews.length;

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
                {totalTanks-1}
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
          · {filteredBrews.length-1} מיכלים
        </span>

      </div>
      <div className="volumeCounter">
        <span>סיכום נפחים במיכלים:</span>
        {Object.entries(totalVolumes).map(
          ([style, volume]) => (
            <div key={style}>
              <span>{style}:</span> {volume} ל'
            </div>
          )
        )}
        <div className="totalVolume">
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