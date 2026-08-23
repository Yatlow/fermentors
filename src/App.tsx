import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
} from "firebase/firestore";
// import { onAuthStateChanged } from "firebase/auth";
// import { auth, db, googleProvider } from "./firebase";
// import { auth, db } from "./firebase";
import {  db } from "./firebase";

import { getTankStage, type TankStageInfo } from "./SERVICES/tankstage"

import "./App.css";
import shpiro from "./assets/shpiro.jpeg";
import DashboardHeader from "./components/DashboardHeader";
import Dashboard from "./components/Dashboard";
import DailyPressureAndTemp from "./components/DailyPressureAndTemp";
import SendMessurmentsHeader from "./components/SendMessurmentsHeader";
import DailyPlatoPH from "./components/DailyPlatoPH";
import NoteToFermentor from "./components/NoteToFermentor";
import PackagingForm from "./components/PackagingForm";
// import { signOut } from "firebase/auth";
// import { signInWithRedirect, signOut } from "firebase/auth";
import { getSpecsFromFb, type SpecChart } from "./SERVICES/getSpecsFromFb";



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
    notes?: string | null;
  } | null;

  [key: string]: unknown;
  stage?: TankStageInfo;
};

export type NewReading = {
  temp?: string | number | null;
  plato?: string | number | null;
  pH?: string | number | null;
  pressure?: string | number | null;
  carbonation?: string | number | null;
  volume?: string | number | null;
  notes?: string | null;
  isEmpty?: boolean;
  kegs?: string | number;
  crates?: string | number;
  refreshTank?: boolean;      // מהתשובה הקודמת (חלק א')
  dryHopGrams?: number;       // חדש
  dryHopType?: string;
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
    useState<"לחץ" | "חם" | "פעולות" | "אריזה">("לחץ");

  const [newReadings, setNewReadings] =
    useState<Record<string, NewReading>>({});

  const [hasIncompleteNotes, setHasIncompleteNotes] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [specs, setSpecs] = useState<SpecChart | null>(null);



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
  const idsNeedingStage = brews.filter(t => t.stage === undefined).map(t => t.id).join(",");
  useEffect(() => {
    if (brews.length === 0) return;

    // אם כבר לכולם יש stage מחושב (למשל אחרי שהעשרנו בעצמנו), לא לרוץ שוב
    const needsStage = brews.some((tank) => tank.stage === undefined);
    if (!needsStage) return;

    let cancelled = false;

    (async () => {
      const enriched = await Promise.all(
        brews.map(async (tank) => {
          const stage = await getTankStage(
            tank as Parameters<typeof getTankStage>[0]
          ).catch(() => undefined);
          return { ...tank, stage };
        })
      );

      if (!cancelled) {
        setBrews(enriched);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [idsNeedingStage]);
  useEffect(() => {
    async function loadSpecs() {
      try {
        const data = await getSpecsFromFb();
        setSpecs(data);
      } catch (error) {
        console.error("Failed to load specs:", error);
      }
    }
    loadSpecs();
  }, []);

  const statusCounts = useMemo<StatusCounts>(() => {
    const counts: StatusCounts = {};
    brews.forEach((tank) => {
      if (Number(tank.tankNumber) === 1) return;
      const status = tank.stage?.name || "לא ידוע";
      counts[status] = (counts[status] || 0) + 1;
    });
    return counts;
  }, [brews]);

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

  const handleUpdatePasivation: (
    tankId: string,
    newDate: string
  ) => Promise<void> = async (
    tankId,
    newDate
  ) => {
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
      if (Number(tank.tankNumber) === 1) {
        return selectedStatuses.includes("הכל") && selectedStyles.includes("הכל");
      }

      const matchesStatus =
        selectedStatuses.includes("הכל") ||
        (tank.stage?.name !== undefined && selectedStatuses.includes(tank.stage.name));

      const style = String(tank.beerStyle ?? "").trim();
      const matchesStyle = selectedStyles.includes("הכל") || selectedStyles.includes(style);

      return matchesStatus && matchesStyle;
    });
  }, [brews, selectedStatuses, selectedStyles]);

  const totalTanks = brews.filter(
    (tank) => Number(tank.tankNumber) !== 1
  ).length;
  const filteredTankCount =
    filteredBrews.filter(
      (tank) => Number(tank.tankNumber) !== 1
    ).length;

  // function login(){
  //   signInWithRedirect(auth,googleProvider).then((result)=>{
  //     console.log("logged in:",result.user)
  //   }).catch((e)=>console.log(e))
  // }

  // function logout() {
  //   signOut(auth)
  // }

  if (loading) {
    return (
      <div className="dashboard-loading">
        <h1>
          טוען נתונים...
        </h1>
      </div>
    );
  }


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
                onClick={() => {
                  setSelectedView("דאשבורד")
                  setSelectedStatuses(["הכל"])
                  setSelectedStyles(["הכל"])
                  setSelectedWrites("לחץ")
                  setNewReadings({})
                }
                }
              >
                דאשבורד
              </div>
              <div className={`views-item ${selectedView === "רישום"
                ? "active" : ""}`}
                onClick={() => {
                  setSelectedView("רישום")
                  setSelectedStatuses(["הכל"])
                  setSelectedStyles(["הכל"])
                  setSelectedWrites("לחץ")
                  setNewReadings({})
                }
                }
              >
                פעולות סלרינג
              </div>
              {/* <div className={`views-item ${selectedView === "דוחות"
                ? "active" : ""}`}
                onClick={() => {
                setSelectedView("דוחות")
               setSelectedStatuses(["הכל"])
setSelectedStyles(["הכל"])
setSelectedWrites("לחץ")
setNewReadings({}) 
              }}
              >
                דוחות
              </div>
              <div className={`views-item ${selectedView === "ניהול" ?
                "active" : ""}`}
                onClick={() => {
                setSelectedView("ניהול")
               //setSelectedStatuses(["הכל"])
setSelectedStyles(["הכל"])
setSelectedWrites("לחץ")
setNewReadings({}) 
              }}
              >
                פעולות ניהול
              </div> */}
            </div>
          </div>


          {selectedView === "דאשבורד" &&
            <DashboardHeader statusCounts={statusCounts} setSelectedStatuses={setSelectedStatuses}
              selectedStatuses={selectedStatuses} totalTanks={totalTanks} statuses={statuses}
            ></DashboardHeader>
          }


          {selectedView === "רישום" &&
            <div className="status-filter">
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "לחץ"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedWrites(
                    "לחץ"
                  )
                  setNewReadings({})
                }
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
                onClick={() => {
                  setSelectedWrites(
                    "חם"
                  )
                  setNewReadings({})
                }
                }
              >
                <span>
                  בדיקות סוכר וpH למיכלים חמים
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "פעולות"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedWrites(
                    "פעולות"
                  )
                  setNewReadings({})
                }
                }
              >
                <span>
                  דיווח פעולות סלרינג
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedWrites === "אריזה"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedWrites(
                    "אריזה"
                  )
                  setNewReadings({})
                }
                }
              >
                <span>
                  דיווח אריזה
                </span>
              </button>
            </div>
          }

        </div>

      </header>
      {selectedView === "דאשבורד" &&
        <Dashboard
          filteredBrews={filteredBrews}
          filteredTankCount={filteredTankCount}
          handleUpdatePasivation={handleUpdatePasivation}
          selectedStatuses={selectedStatuses}
          selectedStyles={selectedStyles}
          setSelectedStyles={setSelectedStyles}
          totalVolumes={totalVolumes}
        ></Dashboard>
      }

      {selectedView === "רישום" &&
        <>
          <SendMessurmentsHeader
            brews={brews}
            newReadings={newReadings}
            setNewReadings={setNewReadings}
            reportName={selectedWrites}
            hasIncompleteNotes={hasIncompleteNotes}
            onResetAll={() => setResetKey((k) => k + 1)}
          ></SendMessurmentsHeader>
          {selectedWrites === "לחץ" && (
            <DailyPressureAndTemp
              brews={brews}
              newReadings={newReadings}
              updateReading={updateReading}
            ></DailyPressureAndTemp>
          )}
          {selectedWrites === "חם" &&
            <DailyPlatoPH
              brews={brews}
              newReadings={newReadings}
              updateReading={updateReading}
            ></DailyPlatoPH>
          }
          {selectedWrites === "פעולות" &&
            <NoteToFermentor
              brews={brews}
              updateReading={updateReading}
              onValidityChange={setHasIncompleteNotes}
              key={resetKey}
              specs={specs}
            >
            </NoteToFermentor>}
          {selectedWrites === "אריזה" &&
            <PackagingForm
              brews={brews}
              updateReading={updateReading}
              onValidityChange={setHasIncompleteNotes}
              key={resetKey}
            >
            </PackagingForm>}
        </>
      }
    </div>
  );
}

export default App;