import { LayoutDashboard, TestTubes, FileChartLine, PocketKnife, Map as MapIcon, Beer, CalendarCog, Menu, ChevronDown, Search } from "lucide-react";
import { observeMeasurementRevisions, stopMeasurementRevisionTracking } from "./SERVICES/getAndPost/gettAllDataByBatch";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
    collection,
    onSnapshot,
    doc,
    updateDoc,
    getDoc,
    serverTimestamp,
    type DocumentData,
} from "firebase/firestore";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { auth, db, googleProvider } from "./firebase";

import { getTankStage, type TankStageInfo } from "./SERVICES/dashboard/tankstage"
import { enableGlobalReadDiagnostics, recordGlobalServerRead } from "./SERVICES/globalReadDiagnostics";
import { hasCredibleLiveBrewProgress } from "./SERVICES/brewing/brewProgressDisplay";
import { setUnsavedEditing } from "./SERVICES/versionGuard";

import "./App.css";
import shpiro from "./assets/shpiro.jpeg";
import DashboardHeader from "./components/dashboard/DashboardHeader";
import Dashboard from "./components/dashboard/Dashboard";
import DailyPressureAndTemp from "./components/cellering/DailyPressureAndTemp";
import { getMeasurementsByBatch, MEASUREMENTS_UPDATED_EVENT } from "./SERVICES/getAndPost/gettAllDataByBatch";
import { cellarBadgeFieldsForDay, pendingCellarMeasurementTankNumbers, type CellarBadgeFields } from "./SERVICES/dashboard/cellarMeasurementBadge";
import { subscribeIgnoredCellarRecommendationsToday, type IgnoredCellarRecommendation } from "./SERVICES/cellering/ignoredCellarRecommendations";
import { graceDayStart, measurementGraceTankIds } from "./SERVICES/dashboard/cellarGrace";
import { localDateKey } from "./SERVICES/dashboard/healthModel";
import CellaringForecast from "./components/cellering/CellaringForecast";
import SendMessurmentsHeader from "./components/cellering/SendMessurmentsHeader";
import DailyPlatoPH from "./components/cellering/DailyPlatoPH";
import NoteToFermentor from "./components/dashboard/NoteToFermentor";
import PackagingForm from "./components/cellering/PackagingForm";
import { type SpecChart } from "./SERVICES/getAndPost/getSpecsFromFb";
import { type ZoneCounts } from "./SERVICES/cooler/Palletservice";
import { subscribeToZoneCounts } from "./SERVICES/cooler/zoneCounts";
import { subscribeToProductCatalog } from "./SERVICES/cooler/PalletCatalogFirestore";
import BeerLoader from "./components/general/Loading";
import { PLANNING_TABS, type PlanningTab } from "./components/planning/planningTabs";
import { BREWING_TABS, type BrewingTab } from "./components/brewing/brewingTabs";

const BatchReportsView = lazy(() => import("./components/reports/BatchReportsView"));
const PackagingReportsView = lazy(() => import("./components/reports/PackagingReportsView"));
const EditSpecs = lazy(() => import("./components/tools/EditSpecs"));
const BrewCalc = lazy(() => import("./components/tools/BrewerCalc"));
const ManualBatchAssignment = lazy(() => import("./components/tools/ManualBatchAssignment"));
const ManualStatusAssignment = lazy(() => import("./components/tools/Manualstatusassignment "));
const EditApprovedUsers = lazy(() => import("./components/tools/EditApprovedUsers"));
const CoolerMap = lazy(() => import("./components/cooler/Coolermap"));
const CoolerUndoControl = lazy(() => import("./components/cooler/CoolerUndoControl"));
const CoolerShipmentLocationAlert = lazy(() => import("./components/cooler/CoolerShipmentLocationAlert"));
const ShipmentReportsView = lazy(() => import("./components/reports/ShipmentReportsView"));
const CoolerInventoryReportView = lazy(() => import("./components/reports/CoolerReportsView "));
const PlanningView = lazy(() => import("./components/planning/PlanningView"));
const BrewingView = lazy(() => import("./components/brewing/BrewingView"));
const UserConnectionReport = lazy(() => import("./components/reports/UserConnectionReport"));
const PackagingSheetGenerator = lazy(() => import("./COMPONENTS/PackagingSheetGenerator"));
const EditProductCatalog = lazy(() => import("./components/tools/EditProductCatalog"));
const ShipmentTraceabilityReport = lazy(() => import("./components/tools/ShipmentTraceabilityReport"));

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
    pasivationDate?: string | Date | FirestoreTimestamp | null;
    beerVolume?: string | number | null;
    sheetUrl?: string | null;
    currentData?: {
        date?: string | null;
        temp?: string | number | null;
        plato?: string | number | null;
        pH?: string | number | null;
        pressure?: string | number | null;
        carbonation?: string | number | null;
        volume?: string | number | null;
        notes?: string | null;
        crates?: number | null;
        kegs?: number | null;
        shrinkagePercent?: number | null;
        totalLiters?: number | null;
    } | null;
    brewProgress?: {
        blockCount?: number | null;
        blockIndex?: number | null;
        stageCode?: number | null;
        stageName?: string | null;
        stageStartTime?: string | null;
        stageEndTime?: string | null;
        stageStartTimeText?: string | null;
        stageEndTimeText?: string | null;
        dateAssumed?: boolean | null;
    } | null;
    [key: string]: unknown;
    stage?: TankStageInfo;
    specificTankNote?: string | null;
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
    refreshTank?: boolean;
    dryHopGrams?: number;
    dryHopType?: string;
    dryHopAa?: number;
    totalLiters?: number;
    shrinkagePercent?: number;
};
export type ReadingToSend = NewReading & {
    tankId: string;
    tankNumber?: string | number | null;
    batchNumber?: string | number | null;
    sheetUrl?: string | null;
    id?: string;
};
type StatusCounts = Record<string, number>;

async function updateLastLoggedInAndGetAdminStatus(user: User): Promise<DocumentData | null> {
    if (!user.email) return null;
    try {
        const userRef = doc(db, "approvedUsers", user.email);
        const userDoc = await getDoc(userRef);
        recordGlobalServerRead("Approved user", userDoc.exists() ? 1 : 0);
        if (!userDoc.exists()) {
            console.warn(`User ${user.email} was not found in approvedUsers`);
            return null;
        }
        const data = userDoc.data();
        await updateDoc(userRef, { lastLoggedIn: serverTimestamp() });
        return data;
    } catch (error) {
        console.error("Error updating last logged in:", error);
        return null;
    }
}

function useAuth() {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [isApproved, setIsApproved] = useState<boolean | null>(null);
    const [admin, setAdmin] = useState(false);
    const [plannerUser, setPlannerUser] = useState(false);
    const [cellarManager, setCellarManager] = useState(false);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
            setUser(nextUser);
            setLoading(true);
            setIsApproved(null);

            if (!nextUser) {
                setIsApproved(false);
                setAdmin(false);
                setPlannerUser(false);
                setCellarManager(false);
                setLoading(false);
                return;
            }

            try {
                enableGlobalReadDiagnostics(nextUser.email);
                const userData = await updateLastLoggedInAndGetAdminStatus(nextUser);
                const approved = userData !== null;
                setIsApproved(approved);
                setAdmin(approved && userData?.isAdmin === true);
                setPlannerUser(approved && userData?.isPlannerUser === true);
                setCellarManager(approved && (userData?.isCellarManager === true || userData?.isAdmin === true));
            } catch (error) {
                console.error("Error updating last logged in:", error);
                setIsApproved(false);
                setAdmin(false);
                setPlannerUser(false);
                setCellarManager(false);
            } finally {
                setLoading(false);
            }
        });
        return () => unsubscribe();
    }, []);

    return { user, loading, isApproved, admin, plannerUser, cellarManager };
}

function App() {
    const [planningTab, setPlanningTab] = useState<PlanningTab>("fiveWeeks");
    const [pendingPlanningWork, setPendingPlanningWork] = useState(0);
    const [brewingTab, setBrewingTab] = useState<BrewingTab>("form");
    const { user, loading: authLoading, isApproved, admin, plannerUser, cellarManager } = useAuth();
    const [brews, setBrews] = useState<Fermentor[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [selectedView, setSelectedView] = useState<string>("דאשבורד");
    const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
    const [openCellarRecommendationCount, setOpenCellarRecommendationCount] = useState(0);
    const [dashboardPendingMeasurementTanks, setDashboardPendingMeasurementTanks] = useState<string[]>([]);
    const [reportSuccess, setReportSuccess] = useState<{ tankNumber: string; tankNumbers?: string[]; label?: string; action: string } | null>(null);
    const [tankSearchOpen, setTankSearchOpen] = useState(false);
    const [tankSearchQuery, setTankSearchQuery] = useState("");
    useEffect(() => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const onSaved = (event: Event) => {
            const detail = (event as CustomEvent<{ tankNumber: string; tankNumbers?: string[]; label?: string; action: string }>).detail;
            if (!detail?.tankNumber) return;
            setReportSuccess(detail);
            if (timeout) window.clearTimeout(timeout);
            const tankNumbers = detail.tankNumbers ?? [detail.tankNumber];
            const slots = Array.from(document.querySelectorAll<HTMLElement>(".dashboard-tank-slot")).filter(el => tankNumbers.includes(el.dataset.tankNumber ?? ""));
            slots.forEach(slot => slot.classList.add("tank-just-updated"));
            timeout = window.setTimeout(() => { setReportSuccess(null); slots.forEach(slot => slot.classList.remove("tank-just-updated")); }, 3000);
        };
        window.addEventListener("cellar-report-saved", onSaved);
        return () => { window.removeEventListener("cellar-report-saved", onSaved); if (timeout) window.clearTimeout(timeout); };
    }, []);
    const [selectedStatuses, setSelectedStatuses] = useState<string[]>(["הכל"]);
    const [selectedStyles, setSelectedStyles] = useState<string[]>(["הכל"]);
    const [selectedWrites, setSelectedWrites] = useState<"לחץ" | "חם" | "פעולות" | "אריזה">("לחץ");
    const [selectedReports, setSelectedReports] = useState<"אריזה" | "גרפים" | "משלוחים" | "מלאי_מקרר" | "חיבורי_משתמשים" | "עקיבות">("אריזה");
    const [selectedAdminTools, setSelectedAdminTools] = useState<"specs" | "calculator" | "changeBatchNumInFv" | "changeFvStatus" | "editEmails" | "packagingSheet" | "catalog">("calculator");
    const [newReadings, setNewReadings] = useState<Record<string, NewReading>>({});
    const [cellarDailyProgress, setCellarDailyProgress] = useState<Record<string, CellarBadgeFields>>({});
    const [cellarGraceProgress, setCellarGraceProgress] = useState<Record<string, CellarBadgeFields>>({});
    const [graceNow, setGraceNow] = useState(() => new Date());
    useEffect(() => {
        const timer = window.setInterval(() => setGraceNow(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    const measurementDayKey = localDateKey(graceNow);
    const graceDayKey = localDateKey(graceDayStart(graceNow));
    const [cellarDailyProgressReady, setCellarDailyProgressReady] = useState(false);
    const [ignoredCellarBadgeRows, setIgnoredCellarBadgeRows] = useState<IgnoredCellarRecommendation[]>([]);
    const [ignoredCellarBadgeReady, setIgnoredCellarBadgeReady] = useState(false);
    const cellarBatchKey = brews.filter(t => Number(t.action) === 1).map(t => String(t.id) + ":" + String(t.batchNumber ?? "")).sort().join("|");
    const needsStandaloneCellarBadge = selectedView !== "דאשבורד";

    useEffect(() => {
        // HealthDashboard owns the counter while mounted. When it unmounts,
        // update the same daily progress from the shared measurement cache in
        // ANY other view (not only when the user opens cellar reporting).
        if (!needsStandaloneCellarBadge) return;
        let cancelled = false;
        let latestRefresh = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        setCellarDailyProgressReady(false);

        const refresh = async () => {
            const generation = ++latestRefresh;
            const asOf = new Date();
            const tanks = brews.filter(t => Number(t.action) === 1 && Number(t.tankNumber) !== 1);
            const entries = await Promise.all(tanks.map(async tank => {
                try {
                    const measurements = tank.batchNumber
                        ? await getMeasurementsByBatch(String(tank.batchNumber))
                        : [];
                    return [tank.id, {
                        today: cellarBadgeFieldsForDay(measurements, asOf),
                        graceDay: cellarBadgeFieldsForDay(measurements, graceDayStart(asOf)),
                    }] as const;
                } catch (error) {
                    console.warn("Unable to refresh cellar badge measurements", tank.tankNumber, error);
                    return null;
                }
            }));
            if (cancelled || generation !== latestRefresh) return;
            // An unavailable history is unknown, NOT a reason to count the
            // tank as unmeasured. This prevents a false badge of all tanks.
            const available = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            setCellarDailyProgress(Object.fromEntries(available.map(([id, fields]) => [id, fields.today])));
            setCellarGraceProgress(Object.fromEntries(available.map(([id, fields]) => [id, fields.graceDay])));
            setCellarDailyProgressReady(true);
        };

        const scheduleRefresh = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; void refresh(); }, 180);
        };
        const onVisible = () => { if (!document.hidden) scheduleRefresh(); };
        void refresh();
        window.addEventListener(MEASUREMENTS_UPDATED_EVENT, scheduleRefresh);
        window.addEventListener("cellar-report-saved", scheduleRefresh);
        window.addEventListener("focus", scheduleRefresh);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            window.removeEventListener(MEASUREMENTS_UPDATED_EVENT, scheduleRefresh);
            window.removeEventListener("cellar-report-saved", scheduleRefresh);
            window.removeEventListener("focus", scheduleRefresh);
            document.removeEventListener("visibilitychange", onVisible);
        };
    // Batch or grace-day/calendar-day rollover invalidates this shared cache.
    // The minute tick itself never causes repeated Firestore reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsStandaloneCellarBadge, cellarBatchKey, measurementDayKey, graceDayKey]);

    useEffect(() => {
        if (!needsStandaloneCellarBadge) return;
        setIgnoredCellarBadgeReady(false);
        return subscribeIgnoredCellarRecommendationsToday(
            (rows) => {
                setIgnoredCellarBadgeRows(rows);
                setIgnoredCellarBadgeReady(true);
            },
            (error) => console.warn("Unable to refresh ignored cellar badge rounds", error),
        );
    }, [needsStandaloneCellarBadge]);

    // One deterministic classification powers reporting cards, badges and the KPI.
    const cellarGraceTankIds = measurementGraceTankIds(brews, cellarGraceProgress, graceNow);

    const cellarPending = (mode: "לחץ" | "חם") => brews.filter(t => {
        if (Number(t.tankNumber) === 1 || Number(t.action) !== 1 || cellarGraceTankIds.has(String(t.id))) return false;
        if (mode === "חם" && !(Number(t.currentData?.temp) > 9 && t.stage?.name === "בתסיסה")) return false;
        const p = cellarDailyProgress[t.id];
        if (!p) return false;
        return mode === "לחץ" ? !(p.temp && p.pressure) : !(p.plato && p.pH);
    }).length;
    const uniquePendingMeasurementCount = needsStandaloneCellarBadge && cellarDailyProgressReady && ignoredCellarBadgeReady
        ? pendingCellarMeasurementTankNumbers(brews, cellarDailyProgress, ignoredCellarBadgeRows, graceNow, cellarGraceProgress).length
        : dashboardPendingMeasurementTanks.length;
    const readingSourceIdentityRef = useRef<Record<string, string>>({});
    const [hasIncompleteNotes, setHasIncompleteNotes] = useState(false);

    const hasUnsavedCellarReading = useMemo(
        () => Object.values(newReadings).some((reading) =>
            Object.values(reading ?? {}).some((value) => value !== undefined && value !== null && value !== "")
        ),
        [newReadings],
    );

    useEffect(() => {
        setUnsavedEditing(hasUnsavedCellarReading);
        return () => setUnsavedEditing(false);
    }, [hasUnsavedCellarReading]);
    const [resetKey, setResetKey] = useState(0);
    const [specs, setSpecs] = useState<SpecChart | null>(null);
    const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
    const [onlyWithCellarRecommendations, setOnlyWithCellarRecommendations] = useState(false);
    const [recommendedTankNumbers, setRecommendedTankNumbers] = useState<string[]>([]);
    const [sortByAge, setSortByAge] = useState<"tank" | "oldest" | "newest" | "packagingSoon" | "packagingLater">("tank");

    useEffect(() => {
        if (!user || !isApproved) {
            setZoneCounts(null);
            return;
        }
        return subscribeToZoneCounts(setZoneCounts);
    }, [user, isApproved]);

    useEffect(() => {
        if (!user || !isApproved) return;
        return subscribeToProductCatalog();
    }, [user, isApproved]);

    useEffect(() => {
        if (!user || !isApproved) {
            setBrews([]);
            setLoading(false);
            stopMeasurementRevisionTracking();
            return;
        }
        setLoading(true);
        const fermentorsRef = collection(db, "fermentors");
        const unsubscribe = onSnapshot(
            fermentorsRef,
            { includeMetadataChanges: true },
            (snapshot) => {
                if (!snapshot.metadata.fromCache) recordGlobalServerRead("Fermentors", snapshot.size);
                observeMeasurementRevisions(snapshot);
                setBrews((prevBrews) => {
                    const prevById = new Map(prevBrews.map((t) => [t.id, t]));
                    const data: Fermentor[] = snapshot.docs.map((firebaseDoc) => {
                        const firestoreData = firebaseDoc.data() as Record<string, unknown>;
                        const id = firebaseDoc.id;
                        const prevTank = prevById.get(id);
                        if (prevTank) {
                            const { stage: _s, ...prevRest } = prevTank;
                            const sameData = JSON.stringify(prevRest) === JSON.stringify({ ...firestoreData, id });
                            if (sameData) return prevTank;
                        }
                        const nextTank = { ...firestoreData, id, stage: undefined } as Fermentor;
                        if (Number(nextTank.action) === 0 && !hasCredibleLiveBrewProgress(nextTank.brewProgress)) {
                            nextTank.brewProgress = null;
                        }
                        return nextTank;
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
                stopMeasurementRevisionTracking();
                console.error("Firestore listener error:", error);
                setLoading(false);
            }
        );
        return () => { unsubscribe(); stopMeasurementRevisionTracking(); };
    }, [user, isApproved]);

    function login() {
        signInWithPopup(auth, googleProvider)
            .catch((e) => console.error(e));
        console.log("Initiated Google sign-in popup");
    }

    function logout() {
        signOut(auth);
    }

    const tanksNeedingStage = useMemo(
        () => brews.filter((tank) => tank.stage === undefined),
        [brews]
    );

    useEffect(() => {
        if (!user || tanksNeedingStage.length === 0) return;
        if (user.email === "itzik@shapirobeer.co.il" && plannerUser) {
            setMobileMoreOpen(false); setSelectedView("תכנון")
        }
        let cancelled = false;
        (async () => {
            const stageById = new Map<string, TankStageInfo | undefined>();
            await Promise.all(
                tanksNeedingStage.map(async (tank) => {
                    const stage = await getTankStage(tank as Parameters<typeof getTankStage>[0]).catch(() => undefined);
                    stageById.set(tank.id, stage);
                })
            );
            if (cancelled) return;
            setBrews((prev) =>
                prev.map((tank) =>
                    stageById.has(tank.id)
                        ? { ...tank, stage: stageById.get(tank.id) }
                        : tank
                )
            );
        })();
        return () => { cancelled = true; };
    }, [tanksNeedingStage, user, plannerUser]);

    useEffect(() => {
        if (!user || !isApproved) {
            setSpecs(null);
            return;
        }
        const specsRef = collection(db, "specs");
        const unsubscribe = onSnapshot(
            specsRef,
            (snapshot) => {
                if (!snapshot.metadata.fromCache) recordGlobalServerRead("Specs", snapshot.size);
                const nextSpecs: SpecChart = {};
                snapshot.docs.forEach((firebaseDoc) => {
                    if (firebaseDoc.id.startsWith("brewing")) return;
                    nextSpecs[firebaseDoc.id] = firebaseDoc.data() as Record<string, number>;
                });
                setSpecs(nextSpecs);
            },
            (error) => {
                console.error("Failed to subscribe to specs:", error);
            }
        );
        return unsubscribe;
    }, [user, isApproved]);

    const statusCounts = useMemo<StatusCounts>(() => {
        const counts: StatusCounts = {};
        brews.forEach((tank) => {
            if (Number(tank.tankNumber) === 1) return;
            const status = tank.stage?.name || "לא ידוע";
            counts[status] = (counts[status] || 0) + 1;
        });
        return counts;
    }, [brews]);

    const statuses = useMemo<string[]>(() => {
        const order = ["בישול חדש", "בתסיסה", "קר", "מלוכלך", "נקי", "מחוטא"];
        const existingStatuses = Object.keys(statusCounts);
        return [
            ...order.filter((status) => existingStatuses.includes(status)),
            ...existingStatuses.filter((status) => !order.includes(status)),
        ];
    }, [statusCounts]);

    useEffect(() => {
        const nextIdentities = Object.fromEntries(
            brews.map((tank) => [
                tank.id,
                `${Number(tank.action ?? -1)}:${String(tank.batchNumber ?? "").replace("#", "").trim()}`,
            ]),
        );
        const previousIdentities = readingSourceIdentityRef.current;
        readingSourceIdentityRef.current = nextIdentities;

        setNewReadings((current) => {
            let changed = false;
            const next = { ...current };
            for (const tankId of Object.keys(current)) {
                const previousIdentity = previousIdentities[tankId];
                if (previousIdentity !== undefined && previousIdentity !== nextIdentities[tankId]) {
                    delete next[tankId];
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [brews]);

    const handleUpdatePasivation = useCallback(async (tankId: string, newDate: string) => {
        try {
            await updateDoc(doc(db, "fermentors", tankId), { pasivationDate: newDate });
        } catch (error) {
            console.error("Error updating pasivation date:", error);
        }
    }, []);

    const updateReading = (tankId: string, field: keyof NewReading, value: string) => {
        setNewReadings((prev) => ({ ...prev, [tankId]: { ...prev[tankId], [field]: value } }));
    };

    const totalVolumes = useMemo<Record<string, number>>(() => {
        const vols: Record<string, number> = {};
        brews.forEach((brew) => {
            const style = String(brew.beerStyle ?? "");
            const volume = Number(brew.beerVolume ?? 0);
            if (!style || Number(brew.action) > 2) return;
            vols[style] = (vols[style] || 0) + volume;
        });
        return vols;
    }, [brews]);

    const filteredBrews = useMemo<Fermentor[]>(() => brews.filter((tank) => {
        if (Number(tank.tankNumber) === 1) return selectedStatuses.includes("הכל") && selectedStyles.includes("הכל");
        const matchesStatus = selectedStatuses.includes("הכל") || (tank.stage?.name !== undefined && selectedStatuses.includes(tank.stage.name));
        const style = String(tank.beerStyle ?? "").trim();
        const matchesStyle = selectedStyles.includes("הכל") || selectedStyles.includes(style);
        return matchesStatus && matchesStyle;
    }), [brews, selectedStatuses, selectedStyles]);

    const totalTanks = brews.filter((tank) => Number(tank.tankNumber) !== 1).length;
    const filteredTankCount = filteredBrews.filter((tank) => Number(tank.tankNumber) !== 1 && (!onlyWithCellarRecommendations || recommendedTankNumbers.includes(String(tank.tankNumber)))).length;

    function getBrewDateValue(brewDate?: string | null): number {
        if (!brewDate) return 0;
        const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(brewDate.trim());
        if (!match) return 0;
        const day = Number(match[1]);
        const month = Number(match[2]);
        const rawYear = Number(match[3]);
        const year = match[3].length === 2 ? 2000 + rawYear : rawYear;
        const date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return 0;
        return date.getTime();
    }

    const sortedFilteredBrews = useMemo<Fermentor[]>(() => {
        if (sortByAge === "oldest" || sortByAge === "newest") {
            return [...filteredBrews].sort((a, b) => {
                const aDate = getBrewDateValue(a.brewDate);
                const bDate = getBrewDateValue(b.brewDate);
                if (!aDate) return bDate ? 1 : 0;
                if (!bDate) return -1;
                return sortByAge === "oldest" ? aDate - bDate : bDate - aDate;
            });
        }
        return filteredBrews;
    }, [filteredBrews, sortByAge]);

    if (authLoading) return <div className="dashboard-loading"><img src={shpiro} alt="Shpiro" className="login-logo" /><BeerLoader message={"טוען משתמש..."} overlay={false} size={"large"} /></div>;
    if (!user) return <div className="dashboard-loading" style={{ flexDirection: "column", gap: "20px" }}><h1>כניסה למערכת</h1><button onClick={login} className="status-filter-button active">התחבר באמצעות Google</button></div>;
    if (isApproved === false) return <div className="dashboard-loading" style={{ flexDirection: "column", gap: "20px" }}><h1>אין לך הרשאות גישה למערכת זו.</h1><button onClick={logout} className="status-filter-button">התנתק</button><img src={shpiro} alt="Shpiro" className="login-logo" /></div>;
    if (isApproved === null) return <div className="dashboard-loading"><img src={shpiro} alt="Shpiro" className="login-logo" /><BeerLoader message={"מבצע כניסה..."} overlay={false} size={"large"} /></div>;
    if (loading) return <div className="dashboard-loading"><img src={shpiro} alt="Shpiro" className="login-logo" /><BeerLoader message={"טוען נתונים..."} overlay={false} size={"large"} /></div>;

    return (
        <div>
            {reportSuccess && <div className="report-success-toast" role="status">✓ {reportSuccess.label ?? `מיכל ${reportSuccess.tankNumber}`} · {reportSuccess.action || "דיווח"} נשמר במערכת</div>}
            <header className="dashboard-header">
                <div className="headerBox">
                    <div className="header-brand">
                        {mobileMoreOpen && <button type="button" className="mobile-nav-backdrop" aria-label="סגירת תפריט ניווט" onClick={() => setMobileMoreOpen(false)} />}
                        <img src={shpiro} alt="Shpiro" className="header-logo" onClick={() => window.location.reload()} />

                        <div className={`mobile-nav-shell ${mobileMoreOpen ? "is-open" : ""}`}>
                        <button type="button" className="mobile-area-trigger" aria-expanded={mobileMoreOpen} aria-controls="primary-area-navigation" onClick={() => setMobileMoreOpen((open) => !open)}><span className="mobile-area-current"><Menu size={22} aria-hidden="true" />{selectedView === "דאשבורד" ? <LayoutDashboard size={21}/> : selectedView === "רישום" ? <TestTubes size={21}/> : selectedView === "דוחות" ? <FileChartLine size={21}/> : selectedView === "ניהול" ? <PocketKnife size={21}/> : selectedView === "מקרר" ? <MapIcon size={21}/> : selectedView === "בישולים" ? <Beer size={21}/> : <CalendarCog size={21}/>}<span>{selectedView === "רישום" ? "פעולות סלרינג" : selectedView === "ניהול" ? "כלים" : selectedView === "מקרר" ? "מפת מקרר" : selectedView}</span></span>{!!zoneCounts?.pending && <span className="mobile-nav-pending-badge" aria-label={`${zoneCounts.pending} משטחים ממתינים לשיבוץ`}>{zoneCounts.pending}</span>}<ChevronDown className={`mobile-nav-chevron ${mobileMoreOpen ? "expanded" : ""}`} size={19} aria-hidden="true" /></button>
                        <nav className={`views-box ${mobileMoreOpen ? "mobile-more-open" : ""}`} id="primary-area-navigation" aria-label="ניווט ראשי">
                            <div className={`views-item ${selectedView === "דאשבורד" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("דאשבורד"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setSelectedAdminTools("calculator"); setNewReadings({}); }}><LayoutDashboard size={20} aria-hidden="true"/><span className="views-label">דאשבורד</span>{openCellarRecommendationCount > 0 && <span className="nav-badge" aria-label={`${openCellarRecommendationCount} המלצות סלרינג פתוחות`}>{openCellarRecommendationCount}</span>}</div>
                            <div className={`views-item ${selectedView === "רישום" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("רישום"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setNewReadings({}); }}><TestTubes size={20} aria-hidden="true"/><span className="views-label">סלרינג</span>{uniquePendingMeasurementCount > 0 && <span className="nav-badge" aria-label={`${uniquePendingMeasurementCount} מיכלים דורשים מדידה`}>{uniquePendingMeasurementCount}</span>}</div>
                            <div className={`views-item ${selectedView === "דוחות" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("דוחות"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setSelectedAdminTools("calculator"); setNewReadings({}); }}><FileChartLine size={20} aria-hidden="true"/><span className="views-label">דוחות</span></div>
                            <div className={`views-item ${selectedView === "ניהול" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("ניהול"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setSelectedAdminTools("calculator"); setNewReadings({}); }}><PocketKnife size={20} aria-hidden="true"/><span className="views-label">כלים</span></div>
                            <div className={`views-item ${selectedView === "מקרר" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("מקרר"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setSelectedAdminTools("calculator"); setNewReadings({}); }}><MapIcon size={20} aria-hidden="true"/><span className="views-label">מפת מקרר</span>{!!zoneCounts?.pending && <span className="nav-badge">{zoneCounts.pending}</span>}</div>
                            <div className={`views-item ${selectedView === "בישולים" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("בישולים"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setSelectedAdminTools("calculator"); setNewReadings({}); }}><Beer size={20} aria-hidden="true"/><span className="views-label">בישולים</span></div>
                            <div className={`views-item ${selectedView === "תכנון" ? "active" : ""}`} onClick={() => { setMobileMoreOpen(false); setSelectedView("תכנון"); setPlanningTab("fiveWeeks"); setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setSelectedWrites("לחץ"); setSelectedReports("אריזה"); setSelectedAdminTools("calculator"); setNewReadings({}); }}><CalendarCog size={20} aria-hidden="true"/><span className="views-label">תכנון</span></div>
                            
                        </nav>
                        </div>
                    </div>
                    {selectedView === "דאשבורד" && <div className="dashboard-filter-toolbar"><div className="tank-search-shell"><button type="button" className="tank-search-toggle" aria-label="חיפוש מיכל או אצווה" aria-expanded={tankSearchOpen} onClick={() => { setTankSearchOpen(v => !v); setMobileMoreOpen(false); }}><Search size={20} aria-hidden="true"/></button>{tankSearchOpen && <div className="tank-search-panel"><input autoFocus type="search" value={tankSearchQuery} onChange={e => setTankSearchQuery(e.target.value)} placeholder="מספר מיכל או אצווה" aria-label="חיפוש מיכל או אצווה"/><button type="button" onClick={() => { setTankSearchOpen(false); setTankSearchQuery(""); }} aria-label="סגור חיפוש">×</button>{tankSearchQuery.trim() && <div className="tank-search-results">{brews.filter(t => String(t.tankNumber).includes(tankSearchQuery.trim()) || String(t.batchNumber ?? "").includes(tankSearchQuery.trim())).slice(0,12).map(t => <button type="button" key={t.id} onClick={() => { setSelectedStatuses(["הכל"]); setSelectedStyles(["הכל"]); setOnlyWithCellarRecommendations(false); setTankSearchOpen(false); setTankSearchQuery(""); window.setTimeout(() => { const slot = document.querySelector<HTMLElement>(`[data-tank-number="${t.tankNumber}"]`); slot?.scrollIntoView({behavior:"smooth",block:"center"}); slot?.classList.add("tank-search-highlight"); if (slot) window.setTimeout(() => slot.classList.remove("tank-search-highlight"), 3000); }, 120); }}>מיכל {t.tankNumber} · אצווה {t.batchNumber || "—"}</button>)}</div>}</div>}</div><DashboardHeader statusCounts={statusCounts} setSelectedStatuses={setSelectedStatuses} selectedStatuses={selectedStatuses} totalTanks={totalTanks} statuses={statuses} sortByAge={sortByAge} setSortByAge={setSortByAge} onlyWithCellarRecommendations={onlyWithCellarRecommendations} setOnlyWithCellarRecommendations={setOnlyWithCellarRecommendations} recommendationCount={new Set(recommendedTankNumbers).size} filteredTankCount={filteredTankCount} /></div>}
                    {selectedView === "רישום" && <div className="status-filter">
                        <button type="button" className={`status-filter-button ${selectedWrites === "לחץ" ? "active" : ""}`} onClick={() => { setSelectedWrites("לחץ"); setNewReadings({}); }}><span>טמפ׳ ולחץ</span>{cellarPending("לחץ") > 0 && <span className="nav-badge">{cellarPending("לחץ")}</span>}</button>
                        <button type="button" className={`status-filter-button ${selectedWrites === "חם" ? "active" : ""}`} onClick={() => { setSelectedWrites("חם"); setNewReadings({}); }}><span>סוכר ו־pH</span>{cellarPending("חם") > 0 && <span className="nav-badge">{cellarPending("חם")}</span>}</button>
                        <button type="button" hidden aria-hidden="true" className={`status-filter-button ${selectedWrites === "פעולות" ? "active" : ""}`} onClick={() => { setSelectedWrites("פעולות"); setNewReadings({}); }}><span>דיווח פעולות סלרינג</span></button>
                        <button type="button" hidden aria-hidden="true" className={`status-filter-button ${selectedWrites === "אריזה" ? "active" : ""}`} onClick={() => { setSelectedWrites("אריזה"); setNewReadings({}); }}><span>דיווח אריזה</span></button>
                    </div>}
                    {selectedView === "דוחות" && <div className="status-filter">
                        <button type="button" className={`status-filter-button ${selectedReports === "אריזה" ? "active" : ""}`} onClick={() => setSelectedReports("אריזה")}><span>דוח אריזות</span></button>
                        <button type="button" className={`status-filter-button ${selectedReports === "משלוחים" ? "active" : ""}`} onClick={() => setSelectedReports("משלוחים")}><span>תעודות משלוח</span></button>
                        <button type="button" className={`status-filter-button ${selectedReports === "עקיבות" ? "active" : ""}`} onClick={() => setSelectedReports("עקיבות")}><span>דוח עקיבות</span></button>
                        <button type="button" className={`status-filter-button ${selectedReports === "מלאי_מקרר" ? "active" : ""}`} onClick={() => setSelectedReports("מלאי_מקרר")}><span>מלאי מוצר מוגמר</span></button>
                        <button type="button" className={`status-filter-button ${selectedReports === "גרפים" ? "active" : ""}`} onClick={() => setSelectedReports("גרפים")}><span>גרפים לפי אצווה</span></button>
                        {user.email?.toLowerCase() === "yisrael@atlow.co.il" && <button type="button" className={`status-filter-button ${selectedReports === "חיבורי_משתמשים" ? "active" : ""}`} onClick={() => setSelectedReports("חיבורי_משתמשים")}><span>חיבורי משתמשים</span></button>}
                    </div>}
                    {selectedView === "ניהול" && <div className="status-filter">
                        <button type="button" className={`status-filter-button ${selectedAdminTools === "calculator" ? "active" : ""}`} onClick={() => setSelectedAdminTools("calculator")}><span>מחשבון למבשלן</span></button>
                        <button type="button" className={`status-filter-button ${selectedAdminTools === "packagingSheet" ? "active" : ""}`} onClick={() => setSelectedAdminTools("packagingSheet")}><span>דף אריזה להדפסה</span></button>
                        
                        <button type="button" className={`status-filter-button ${selectedAdminTools === "specs" ? "active" : ""}`} onClick={() => setSelectedAdminTools("specs")}><span>הגדרות סלרינג</span></button>
                        {cellarManager && <button type="button" className={`status-filter-button ${selectedAdminTools === "changeBatchNumInFv" ? "active" : ""}`} onClick={() => setSelectedAdminTools("changeBatchNumInFv")}><span>שינוי אצווה במיכל- ידנית</span></button>}
                        {cellarManager && <button type="button" className={`status-filter-button ${selectedAdminTools === "changeFvStatus" ? "active" : ""}`} onClick={() => setSelectedAdminTools("changeFvStatus")}><span>שינוי סטטוס במיכל- ידנית</span></button>}
                        {admin && <button type="button" className={`status-filter-button ${selectedAdminTools === "catalog" ? "active" : ""}`} onClick={() => setSelectedAdminTools("catalog")}><span>ניהול קטלוג</span></button>}
                        {admin && <button type="button" className={`status-filter-button ${selectedAdminTools === "editEmails" ? "active" : ""}`} onClick={() => setSelectedAdminTools("editEmails")}><span>משתמשים והרשאות</span></button>}
                    </div>}
                    {selectedView === "בישולים" && <nav className="status-filter" dir="rtl" aria-label="בישולים">{BREWING_TABS.map(([id, label]) => <button key={id} type="button" className={`status-filter-button ${brewingTab === id ? "active" : ""}`} aria-pressed={brewingTab === id} onClick={() => setBrewingTab(id)}>{label}</button>)}</nav>}
                    {selectedView === "תכנון" && <nav className="status-filter" dir="rtl" aria-label="תכנון">{(plannerUser ? PLANNING_TABS : PLANNING_TABS.filter(([id]) => id === "fiveWeeks")).map(([id, label]) => <button key={id} type="button" className={`status-filter-button ${planningTab === id ? "active" : ""}`} aria-pressed={planningTab === id} data-planning-badge={id === "schedule" && pendingPlanningWork > 0 ? pendingPlanningWork : undefined} onClick={() => setPlanningTab(id)}>{label}</button>)}</nav>}
                </div>
            </header>

            <Suspense fallback={<div className="dashboard-loading"><BeerLoader message="טוען תצוגה..." overlay={false} size="large" /></div>}>
                {selectedView === "דאשבורד" && <Dashboard onlyWithCellarRecommendations={onlyWithCellarRecommendations} recommendedTankNumbers={recommendedTankNumbers} onRecommendedTanksChange={setRecommendedTankNumbers} onOpenRecommendationCountChange={setOpenCellarRecommendationCount} onPendingMeasurementTanksChange={setDashboardPendingMeasurementTanks} sortMode={sortByAge} healthBrews={brews} filteredBrews={sortedFilteredBrews} filteredTankCount={filteredTankCount} handleUpdatePasivation={handleUpdatePasivation} selectedStatuses={selectedStatuses} selectedStyles={selectedStyles} setSelectedStyles={setSelectedStyles} totalVolumes={totalVolumes} specs={specs} />}
                {selectedView === "תכנון" && <PlanningView brews={brews} canEdit={plannerUser} tab={planningTab} onTabChange={setPlanningTab} onPendingDailyWorkChange={setPendingPlanningWork} onOpenCoolerMap={() => { setMobileMoreOpen(false); setSelectedView("מקרר"); }} />}
                {selectedView === "רישום" && <>
                    <CellaringForecast brews={brews} specs={specs} />
                    <SendMessurmentsHeader brews={brews} newReadings={newReadings} setNewReadings={setNewReadings} reportName={selectedWrites} hasIncompleteNotes={hasIncompleteNotes} onResetAll={() => setResetKey((k) => k + 1)} specs={specs} />
                    {selectedWrites === "לחץ" && <DailyPressureAndTemp brews={brews} newReadings={newReadings} updateReading={updateReading} dailyProgress={cellarDailyProgress} graceTankIds={cellarGraceTankIds} />}
                    {selectedWrites === "חם" && <DailyPlatoPH brews={brews} newReadings={newReadings} updateReading={updateReading} dailyProgress={cellarDailyProgress} graceTankIds={cellarGraceTankIds} />}
                    {selectedWrites === "פעולות" && <NoteToFermentor brews={brews} updateReading={updateReading} onValidityChange={setHasIncompleteNotes} key={resetKey} specs={specs} />}
                    {selectedWrites === "אריזה" && <PackagingForm brews={brews} updateReading={updateReading} onValidityChange={setHasIncompleteNotes} key={resetKey} />}
                </>}

                {selectedView === "דוחות" && selectedReports === "אריזה" && <PackagingReportsView />}
                {selectedView === "דוחות" && selectedReports === "משלוחים" && <ShipmentReportsView />}
                {selectedView === "דוחות" && selectedReports === "מלאי_מקרר" && <CoolerInventoryReportView />}
                {selectedView === "דוחות" && selectedReports === "גרפים" && <BatchReportsView currentFermentors={brews} />}
                {selectedView === "דוחות" && selectedReports === "חיבורי_משתמשים" && user.email?.toLowerCase() === "yisrael@atlow.co.il" && <UserConnectionReport />}
                {selectedView === "ניהול" && selectedAdminTools === "specs" && <EditSpecs isAdmin={cellarManager} />}
                {selectedView === "ניהול" && selectedAdminTools === "calculator" && <BrewCalc brews={brews} />}
                {selectedView === "ניהול" && selectedAdminTools === "packagingSheet" && <PackagingSheetGenerator brews={brews} specs={specs} />}
                {selectedView === "דוחות" && selectedReports === "עקיבות" && <ShipmentTraceabilityReport />}
                {selectedView === "ניהול" && selectedAdminTools === "changeBatchNumInFv" && <ManualBatchAssignment brews={brews} isAdmin={cellarManager} />}
                {selectedView === "ניהול" && selectedAdminTools === "changeFvStatus" && <ManualStatusAssignment brews={brews} isAdmin={cellarManager} />}
                {selectedView === "ניהול" && selectedAdminTools === "catalog" && <EditProductCatalog isAdmin={admin} />}
                {selectedView === "ניהול" && selectedAdminTools === "editEmails" && <EditApprovedUsers isAdmin={admin} />}
                {selectedView === "מקרר" && <>
                    <CoolerMap brews={brews} />
                    <CoolerUndoControl />
                    <CoolerShipmentLocationAlert />
                </>}
                {selectedView === "בישולים" && <BrewingView brews={brews} tab={brewingTab} />}
            </Suspense>
        </div>
    );
}

export default App;