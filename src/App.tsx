import { useEffect, useMemo, useState, useCallback } from "react";
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
  getDoc,
  serverTimestamp,
} from "firebase/firestore";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, db, googleProvider } from "./firebase";



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
import { getSpecsFromFb, type SpecChart } from "./SERVICES/getSpecsFromFb";
import BatchReportsView from "./components/BatchReportsView";
import PackagingReportsView from "./components/PackagingReportsView";
import EditSpecs from "./components/EditSpecs";
import BrewCalc from "./components/BrewerCalc";
import  Building  from "./components/Building";



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




async function checkAproovedUser(user: any): Promise<boolean> {
  try {
    const docRef = doc(db, "approvedUsers", user.email);
    const docSnap = await getDoc(docRef);
    return docSnap.exists();
  } catch (error) {
    console.error("Error checking approved user:", error);
    return false;
  }
}

async function updateLastLoggedIn(user: any) {
  if (!user?.email) return;

  try {
    const userRef = doc(db, "approvedUsers", user.email);

    await updateDoc(userRef, {
      lastLoggedIn: serverTimestamp(),
    });

  } catch (error) {
    console.error("Error updating last logged in:", error);
  }
}



function useAuth() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);

      if (user) {
        void updateLastLoggedIn(user);
      }
    });
    return () => unsubscribe();
  }, []);

  return { user, loading };
}

function App() {
  const { user, loading: authLoading } = useAuth();
  const [isApproved, setIsApproved] = useState<boolean | null>(null);

  const [loggingIn, setLoggingIn] = useState<boolean>(true);

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

  const [selectedReports, setSelectedReports] =
    useState<"אריזה" | "גרפים">("אריזה");

  const [selectedAdminTools, setSelectedAdminTools] =
    useState<"specs" | "calculator" | "changeBatchNumInFv" | "changeFvStatus">("calculator");

  const [newReadings, setNewReadings] =
    useState<Record<string, NewReading>>({});

  const [hasIncompleteNotes, setHasIncompleteNotes] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [specs, setSpecs] = useState<SpecChart | null>(null);



  useEffect(() => {
    if (user) {
      checkAproovedUser(user)
        .then((approved) => setIsApproved(approved))
        .catch((e) => {
          console.error("Error checking approved user:", e);
          setIsApproved(false);
        });
      setLoggingIn(false);
    }
  }, [user]);



  useEffect(() => {
    if (!user || !isApproved) {
      return
    }
    const fermentorsRef = collection(db, "fermentors");

    const unsubscribe = onSnapshot(
      fermentorsRef,
      (snapshot) => {
        setBrews((prevBrews) => {
          const prevById = new Map(prevBrews.map((t) => [t.id, t]));

          const data: Fermentor[] = snapshot.docs.map((firebaseDoc) => {
            const firestoreData = firebaseDoc.data() as Record<string, unknown>;
            const id = firebaseDoc.id;
            const prevTank = prevById.get(id);

            if (prevTank) {
              const { stage: _s, ...prevRest } = prevTank;
              const sameData = JSON.stringify(prevRest) === JSON.stringify({ ...firestoreData, id });
              if (sameData) return prevTank; // רפרנס זהה -> React.memo יוכל לדלג
            }

            return { ...firestoreData, id, stage: undefined } as Fermentor;
          });

          data.sort((a, b) => {
            const numA = parseInt(String(a.uid ?? "").replace(/\D/g, ""), 10) || 0;
            const numB = parseInt(String(b.uid ?? "").replace(/\D/g, ""), 10) || 0;
            return numA - numB;
          });

          return data;
        });
        setLoading(false);
      },
      (error) => {
        console.error("Firestore listener error:", error);
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, [user, isApproved]);


  function login() {

    signInWithPopup(auth, googleProvider).catch((e) => console.error(e));
    console.log("Initiated Google sign-in redirect");
  }


  function logout() {
    signOut(auth)
  }


  const idsNeedingStage = brews.filter(t => t.stage === undefined).map(t => t.id).join(",");
  useEffect(() => {
    if (brews.length === 0) return;


    const tanksNeedingStage = brews.filter((tank) => tank.stage === undefined);
    if (tanksNeedingStage.length === 0) return;

    let cancelled = false;

    (async () => {
      const stageById = new Map<string, TankStageInfo | undefined>();
      await Promise.all(
        tanksNeedingStage.map(async (tank) => {
          const stage = await getTankStage(
            tank as Parameters<typeof getTankStage>[0]
          ).catch(() => undefined);
          stageById.set(tank.id, stage);
        })
      );
      if (cancelled) return;
      setBrews((prev) =>
        prev.map((tank) =>
          stageById.has(tank.id)
            ? { ...tank, stage: stageById.get(tank.id) }
            : tank // לא נגענו בו -> אותו רפרנס בדיוק
        )
      );
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

  const handleUpdatePasivation = useCallback(async (tankId: string, newDate: string) => {
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
  }, []);

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

  if (authLoading) {
    return (
      <div className="dashboard-loading">
        <h1>טוען משתמש...</h1>
        <img
          src={shpiro}
          alt="Shpiro"
          className="login-logo"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="dashboard-loading" style={{ flexDirection: "column", gap: "20px" }}>
        <h1>כניסה למערכת</h1>
        <button onClick={login} className="status-filter-button active">
          התחבר באמצעות Google
        </button>
      </div>
    );
  }


  if (isApproved === false) {
    return (
      <div className="dashboard-loading" style={{ flexDirection: "column", gap: "20px" }}>
        <h1>אין לך הרשאות גישה למערכת זו.</h1>
        <button onClick={logout} className="status-filter-button">
          התנתק
        </button>
        <img
          src={shpiro}
          alt="Shpiro"
          className="login-logo"
        />
      </div>
    );
  }

  if (loggingIn || isApproved === null) {
    return (
      <div className="dashboard-loading">
        <h1>מבצע כניסה...</h1>
        <img
          src={shpiro}
          alt="Shpiro"
          className="login-logo"
        />
      </div>
    );
  }



  if (loading) {
    return (
      <div className="dashboard-loading">
        <h1>
          טוען נתונים...
        </h1>
        <img
          src={shpiro}
          alt="Shpiro"
          className="login-logo"
        />
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
                  setSelectedReports("אריזה")
                  setSelectedAdminTools("calculator")
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
                  setSelectedReports("אריזה")
                  setNewReadings({})
                }
                }
              >
                פעולות סלרינג
              </div>
              <div className={`views-item ${selectedView === "דוחות"
                ? "active" : ""}`}
                onClick={() => {
                  setSelectedView("דוחות")
                  setSelectedStatuses(["הכל"])
                  setSelectedStyles(["הכל"])
                  setSelectedWrites("לחץ")
                  setSelectedReports("אריזה")
                  setSelectedAdminTools("calculator")
                  setNewReadings({})
                }}
              >
                דוחות
              </div>
              <div className={`views-item ${selectedView === "ניהול" ?
                "active" : ""}`}
                onClick={() => {
                setSelectedView("ניהול")
               setSelectedStatuses(["הכל"])
              setSelectedStyles(["הכל"])
              setSelectedWrites("לחץ")
              setSelectedReports("אריזה")
              setSelectedAdminTools("calculator")
              setNewReadings({}) 
                    }}
                    >
                      כלים
                    </div>
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
          {selectedView === "דוחות" &&
            <div className="status-filter">
              <button
                type="button"
                className={`status-filter-button ${selectedReports === "אריזה"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedReports("אריזה")
                    
                }
                }
              >
                <span>
                  דוח אריזות
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedReports === "גרפים"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedReports("גרפים")
                }
                }
              >
                <span>
                  גרפים לפי אצווה
                </span>
              </button>
            </div>
          }
          {selectedView === "ניהול" &&
            <div className="status-filter">
              <button
                type="button"
                className={`status-filter-button ${selectedAdminTools === "calculator"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedAdminTools("calculator")
                }
                }
              >
                <span>
                  מחשבון למבשלן
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedAdminTools === "specs"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedAdminTools("specs")
                }
                }
              >
                <span>
                  הגדרות לבירה
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedAdminTools === "changeBatchNumInFv"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedAdminTools("changeBatchNumInFv")
                }
                }
              >
                <span>
                  שינוי אצווה במיכל- ידנית
                </span>
              </button>
              <button
                type="button"
                className={`status-filter-button ${selectedAdminTools === "changeFvStatus"
                  ? "active"
                  : ""
                  }`}
                onClick={() => {
                  setSelectedAdminTools("changeFvStatus")
                }
                }
              >
                <span>
                  שינוי סטטוס במיכל- ידנית
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

      {selectedView === "דוחות" && selectedReports==="גרפים" && <BatchReportsView currentFermentors={brews} />}
      {selectedView === "דוחות" && selectedReports==="אריזה" && <PackagingReportsView/>}

      {selectedView === "ניהול" && selectedAdminTools==="specs" && <EditSpecs />}
      {selectedView === "ניהול" && selectedAdminTools==="calculator" && <BrewCalc brews={brews} />}
      {selectedView === "ניהול" && selectedAdminTools==="changeBatchNumInFv" && <Building/>}
      {selectedView === "ניהול" && selectedAdminTools==="changeFvStatus" && <Building/>}
    </div>
  );
}

export default App;