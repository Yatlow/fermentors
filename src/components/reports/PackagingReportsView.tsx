import BeerLoader from "../general/Loading";
// components/PackagingReportsView.tsx

import { useEffect, useMemo, useState } from "react";
import {
    collection,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    startAfter,
    type DocumentData,
    type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "../../firebase";
import { brewById, resolvePackagingBrewId, type PackagingPlan } from "../../SERVICES/planning/planIdentity";
import type { WeekPlan } from "../../SERVICES/planning/planningEngine";

// ============================================================
// TYPES
// ============================================================

type RangeMode = "range" | "week";

type PackagingRow = {
    id: string;
    date: string; // dd/mm/yyyy
    timestamp: number;
    expiryDateStr: string;
    itemLabel: string; // סגנון / פריט
    packagingType: "kegs" | "bottles" | null;
    unit: string;
    quantity: number;
    batchNumber?: string | number | null;
    tankNumber?: string | number | null;
    source: "actual" | "estimated";
};

export type PackagingLogDoc = {
    date?: string;
    timestamp?: number;
    expiryDateStr?: string;
    beerStyle?: string;
    packagingType?: "kegs" | "bottles";
    unit?: string;
    quantity?: number;
    batchNumber?: string | number;
    tankNumber?: string | number;
};

type PlanningWeekDoc = WeekPlan;

type PlanningSettingsDoc = {
    products?: Array<{ id: string; style: string; type: "crates" | "kegs" }>;
};

const REPORT_PAGE_SIZE = 50;
const PLANNED_PACKAGING_CACHE_MS = 60 * 1000;

type PlannedPackagingCache = {
    key: string;
    loadedAt: number;
    data?: number[];
    pending?: Promise<number[]>;
};

let plannedPackagingCache: PlannedPackagingCache | null = null;


// ============================================================
// DATE HELPERS
// ============================================================

function toStartOfDay(d: Date): Date {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
}

function toEndOfDay(d: Date): Date {
    const r = new Date(d);
    r.setHours(23, 59, 59, 999);
    return r;
}

function formatDDMMYYYY(d: Date): string {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();

    return `${dd}/${mm}/${yyyy}`;
}

function toDateInputValue(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
}

function todayInputValue(): string {
    return toDateInputValue(new Date());
}

/**
 * תחילת השבוע - תמיד יום ראשון.
 *
 * השבוע שלנו הוא:
 * ראשון 00:00 -> שבת 23:59:59
 *
 * אין כאן שימוש ב-ISO לצורך גבולות השבוע.
 */
function getWeekStart(d: Date): Date {
    const r = toStartOfDay(d);
    const day = r.getDay(); // 0 = ראשון

    r.setDate(r.getDate() - day);

    return r;
}

function addDays(d: Date, days: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + days);

    return r;
}

/**
 * מספר שבוע ISO.
 *
 * מכיוון שהשבוע אצלנו מתחיל ביום ראשון ולא שני,
 * אנחנו מייצגים את השבוע באמצעות יום חמישי שבתוכו.
 *
 * לדוגמה:
 * שבוע 23/08/2026 - 29/08/2026
 * מיוצג לפי יום חמישי 27/08/2026
 * ולכן מקבל ISO week 35.
 */
export function getNormalizedWeekNumber(weekStart: Date): number {
    const sunday = getWeekStart(weekStart);

    // חמישי הוא היום הרביעי בשבוע ראשון-שבת
    const thursday = addDays(sunday, 4);

    // ISO week calculation
    const target = new Date(
        thursday.getFullYear(),
        thursday.getMonth(),
        thursday.getDate()
    );

    const dayNr = (target.getDay() + 6) % 7; // Monday = 0

    target.setDate(target.getDate() - dayNr + 3);

    const firstThursday = new Date(
        target.getFullYear(),
        0,
        4
    );

    const firstDayNr = (firstThursday.getDay() + 6) % 7;

    firstThursday.setDate(
        firstThursday.getDate() - firstDayNr + 3
    );

    const weekNumber =
        1 +
        Math.round(
            (target.getTime() - firstThursday.getTime()) /
            (7 * 24 * 60 * 60 * 1000)
        );

    return weekNumber;
}

/**
 * השנה שאליה שייך מספר השבוע.
 *
 * חשוב במיוחד במעבר בין דצמבר לינואר.
 */
export function getNormalizedWeekYear(weekStart: Date): number {
    const sunday = getWeekStart(weekStart);
    const thursday = addDays(sunday, 4);

    return thursday.getFullYear();
}

function normalizeItemLabel(raw: string): string {
    const trimmed = (raw || "").trim();
    if (!trimmed) return trimmed;
    // אותיות לועזיות בלבד (IPA) -> אחיד לאותיות גדולות
    return /^[a-zA-Z\s]+$/.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

export function getNormalizedWeekKey(weekStart: Date): string {
    const year = getNormalizedWeekYear(weekStart);
    const week = getNormalizedWeekNumber(weekStart);

    return `${year}-W${String(week).padStart(2, "0")}`;
}

export function formatWeekLabel(weekStart: Date): string {
    const start = getWeekStart(weekStart);
    const end = addDays(start, 6);

    const weekNumber = getNormalizedWeekNumber(start);

    return `שבוע ${weekNumber} · ${formatDDMMYYYY(start)} – ${formatDDMMYYYY(end)}`;
}


function getWeeksForYear(year: number): Date[] {
    const result: Date[] = [];

    const firstDayOfYear = new Date(year, 0, 1);

    // מתחילים מהשבוע שמכיל את 1 בינואר
    let current = getWeekStart(firstDayOfYear);

    // מספיק עד השבוע שמכיל 31 בדצמבר
    const lastDayOfYear = new Date(year, 11, 31);
    const lastWeekStart = getWeekStart(lastDayOfYear);

    while (current.getTime() <= lastWeekStart.getTime()) {
        result.push(new Date(current));
        current = addDays(current, 7);
    }

    return result;
}

function getWeekOptions(): Date[] {
    const currentYear = new Date().getFullYear();

    const weeks = [
        ...getWeeksForYear(currentYear - 1),
        ...getWeeksForYear(currentYear),
        ...getWeeksForYear(currentYear + 1),
    ];

    // הסרת כפילויות לפי week key
    const map = new Map<string, Date>();

    weeks.forEach((week) => {
        map.set(getNormalizedWeekKey(week), week);
    });

    return Array.from(map.values()).sort(
        (a, b) => a.getTime() - b.getTime()
    );
}

export async function getPlannedPackagingContainerNumbers(): Promise<number[]> {
    const currentWeekStart = getWeekStart(new Date());
    const nextWeekStart = addDays(currentWeekStart, 7);
    const nextWeekId = toDateInputValue(nextWeekStart);
    const key = nextWeekId;
    const now = Date.now();

    if (
        plannedPackagingCache?.key === key &&
        plannedPackagingCache.data &&
        now - plannedPackagingCache.loadedAt < PLANNED_PACKAGING_CACHE_MS
    ) {
        return [...plannedPackagingCache.data];
    }
    if (plannedPackagingCache?.key === key && plannedPackagingCache.pending) {
        return [...await plannedPackagingCache.pending];
    }

    // Packaging decisions can point to a brew created in an earlier planning
    // week. Loading only next week's document makes resolvePackagingBrewId()
    // blind to that brew, so a run without its own tank (for example tank 16)
    // disappears from the Wednesday/Thursday cellar recommendations.
    const historyStart = toDateInputValue(addDays(nextWeekStart, -84));
    const pending = getDocs(
        query(
            collection(db, "planningWeeks"),
            where("id", ">=", historyStart),
            where("id", "<=", nextWeekId)
        )
    ).then((snapshot) => {
        const plans = snapshot.docs
            .map((doc) => doc.data() as PlanningWeekDoc)
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const week = plans.find((plan) => String(plan.id) === nextWeekId);
        if (!week) return [];

        const tankNumbers = (week.packaging ?? [])
            .map((raw) => {
                const run = raw as PackagingPlan;
                const brewId = resolvePackagingBrewId(run, plans);
                const linkedBrew = brewId ? brewById(plans, brewId) : null;
                return Number(run.tankNumber ?? run.tankId ?? linkedBrew?.tankId);
            })
            .filter((tankNumber) => Number.isFinite(tankNumber) && tankNumber > 0);
        return [...new Set(tankNumbers)];
    });

    plannedPackagingCache = { key, loadedAt: now, pending };
    try {
        const data = await pending;
        plannedPackagingCache = { key, loadedAt: Date.now(), data };
        return [...data];
    } catch (error) {
        if (plannedPackagingCache?.key === key) plannedPackagingCache = null;
        throw error;
    }
}

function formatISODateToDDMMYYYY(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}


export default function PackagingReportsView() {
    const [mode, setMode] = useState<RangeMode>("week");

    const [startDate, setStartDate] = useState<string>(
        () => toDateInputValue(addDays(new Date(), -29))
    );

    const [endDate, setEndDate] = useState<string>(
        todayInputValue()
    );

    // תמיד מנורמל ליום ראשון 00:00 של השבוע הנבחר
    const [weekStart, setWeekStart] = useState<Date>(() =>
        getWeekStart(new Date())
    );

    const [showWeekJump, setShowWeekJump] = useState(false);

    const [rows, setRows] = useState<PackagingRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [actualCursor, setActualCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
    const [hasMoreActual, setHasMoreActual] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const weekOptions = useMemo(() => getWeekOptions(), []);

    // ========================================================
    // RESOLVE SELECTED RANGE
    // ========================================================

    const range = useMemo<{ start: Date; end: Date } | null>(() => {
        if (mode === "week") {
            return {
                start: weekStart,
                end: toEndOfDay(addDays(weekStart, 6)),
            };
        }

        if (!startDate || !endDate) {
            return null;
        }

        const start = toStartOfDay(new Date(startDate));
        const end = toEndOfDay(new Date(endDate));

        if (start.getTime() > end.getTime()) {
            return null;
        }

        return {
            start,
            end,
        };
    }, [mode, weekStart, startDate, endDate]);

    // ========================================================
    // WEEK NAVIGATION
    // ========================================================

    function goPrevWeek() {
        setWeekStart((prev) => addDays(prev, -7));
    }

    function goNextWeek() {
        setWeekStart((prev) => addDays(prev, 7));
    }

    function goThisWeek() {
        setWeekStart(getWeekStart(new Date()));
    }

    function jumpToDate(dateStr: string) {
        if (!dateStr) {
            return;
        }

        setWeekStart(getWeekStart(new Date(dateStr)));
        setShowWeekJump(false);
    }

    function jumpToWeek(weekKey: string) {
        const selected = weekOptions.find(
            (week) => getNormalizedWeekKey(week) === weekKey
        );

        if (selected) {
            setWeekStart(selected);
        }
    }

    // ========================================================
    // LOAD DATA
    // ========================================================
    useEffect(() => {
        if (!range) {
            setRows([]);
            setActualCursor(null);
            setHasMoreActual(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);
        setActualCursor(null);
        setHasMoreActual(false);

        const startTs = range.start.getTime();
        const endTs = range.end.getTime();
        const now = Date.now();

        async function load() {
            try {
                const actualRowsPromise = getDocs(
                    query(
                        collection(db, "packagingLog"),
                        where("timestamp", ">=", startTs),
                        where("timestamp", "<=", endTs),
                        orderBy("timestamp", "desc"),
                        limit(REPORT_PAGE_SIZE + 1)
                    )
                );

                const todayStart = toStartOfDay(new Date(now)).getTime();
                const shouldLoadEstimated = endTs >= now;
                const estimatedStartDate = new Date(Math.max(startTs, todayStart));
                const estimatedEndDate = new Date(endTs);
                const planningStart = toDateInputValue(getWeekStart(estimatedStartDate));
                const planningEnd = toDateInputValue(addDays(getWeekStart(estimatedEndDate), 7));

                const [actualSnap, planningSnap, settingsSnap] = await Promise.all([
                    actualRowsPromise,
                    shouldLoadEstimated
                        ? getDocs(query(
                            collection(db, "planningWeeks"),
                            where("id", ">=", planningStart),
                            where("id", "<", planningEnd)
                        ))
                        : Promise.resolve(null),
                    shouldLoadEstimated
                        ? getDocs(query(collection(db, "planningSettings"), limit(1)))
                        : Promise.resolve(null),
                ]);
                if (cancelled) return;

                const visibleActualDocs = actualSnap.docs.slice(0, REPORT_PAGE_SIZE);
                const actualRows: PackagingRow[] = visibleActualDocs.map((d) => {
                    const data = d.data() as PackagingLogDoc;
                    return {
                        id: d.id,
                        date: data.date ?? "",
                        timestamp: data.timestamp ?? 0,
                        expiryDateStr: data.expiryDateStr ?? "",
                        itemLabel: normalizeItemLabel(data.beerStyle ?? ""),
                        packagingType: data.packagingType ?? null,
                        unit: data.unit ?? (data.packagingType === "kegs" ? "חביות" : "ארגזים"),
                        quantity: Number(data.quantity ?? 0),
                        batchNumber: data.batchNumber,
                        tankNumber: data.tankNumber ?? null,
                        source: "actual",
                    };
                });

                const products = settingsSnap?.docs[0]?.data()
                    ? ((settingsSnap.docs[0].data() as PlanningSettingsDoc).products ?? [])
                    : [];
                const productById = new Map(products.map((product) => [product.id, product]));
                const estimatedRowsRaw: PackagingRow[] = planningSnap
                    ? planningSnap.docs.flatMap((weekDoc) => {
                        const week = weekDoc.data() as PlanningWeekDoc;
                        return (week.packaging ?? []).flatMap((run, index) => {
                            if (!run.date) return [];
                            const runDate = new Date(`${run.date}T12:00:00`);
                            const timestamp = runDate.getTime();
                            if (timestamp < Math.max(startTs, todayStart) || timestamp > endTs) return [];
                            const product = productById.get(String(run.productId ?? ""));
                            return [{
                                id: run.id ?? `${weekDoc.id}:${index}`,
                                date: formatISODateToDDMMYYYY(run.date),
                                timestamp,
                                expiryDateStr: "",
                                itemLabel: normalizeItemLabel(product?.style ?? String(run.productId ?? "")),
                                packagingType: product?.type === "kegs" ? "kegs" : product?.type === "crates" ? "bottles" : null,
                                unit: product?.type === "kegs" ? "חביות" : product?.type === "crates" ? "ארגזים" : "",
                                quantity: Number(run.quantity ?? 0),
                                batchNumber: null,
                                tankNumber: run.tankNumber ?? run.tankId ?? null,
                                source: "estimated" as const,
                            }];
                        });
                    })
                    : [];

                const actualKeys = new Set(
                    actualRows
                        .filter((row) => row.tankNumber != null)
                        .map((row) => `${row.date}__${row.tankNumber}`)
                );
                const estimatedRows = estimatedRowsRaw.filter((row) =>
                    row.tankNumber == null || !actualKeys.has(`${row.date}__${row.tankNumber}`)
                );

                setRows([...actualRows, ...estimatedRows].sort((a, b) => b.timestamp - a.timestamp));
                setHasMoreActual(actualSnap.docs.length > REPORT_PAGE_SIZE);
                setActualCursor(
                    actualSnap.docs.length > REPORT_PAGE_SIZE && visibleActualDocs.length
                        ? visibleActualDocs[visibleActualDocs.length - 1]
                        : null
                );
            } catch (err) {
                console.error("Failed loading packaging report:", err);
                if (!cancelled) {
                    setError("שגיאה בטעינת הדוח. ייתכן שנדרש אינדקס בפיירסטור - בדוק את הקונסול לקישור ליצירתו.");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void load();
        return () => {
            cancelled = true;
        };
    }, [range]);

    async function loadMoreActualRows() {
        if (!range || !actualCursor || !hasMoreActual || loadingMore) return;
        setLoadingMore(true);
        try {
            const snapshot = await getDocs(
                query(
                    collection(db, "packagingLog"),
                    where("timestamp", ">=", range.start.getTime()),
                    where("timestamp", "<=", range.end.getTime()),
                    orderBy("timestamp", "desc"),
                    startAfter(actualCursor),
                    limit(REPORT_PAGE_SIZE + 1)
                )
            );
            const visible = snapshot.docs.slice(0, REPORT_PAGE_SIZE);
            const moreRows: PackagingRow[] = visible.map((d) => {
                const data = d.data() as PackagingLogDoc;
                return {
                    id: d.id,
                    date: data.date ?? "",
                    timestamp: data.timestamp ?? 0,
                    expiryDateStr: data.expiryDateStr ?? "",
                    itemLabel: normalizeItemLabel(data.beerStyle ?? ""),
                    packagingType: data.packagingType ?? null,
                    unit: data.unit ?? (data.packagingType === "kegs" ? "חביות" : "ארגזים"),
                    quantity: Number(data.quantity ?? 0),
                    batchNumber: data.batchNumber,
                    tankNumber: data.tankNumber ?? null,
                    source: "actual",
                };
            });

            setRows((current) => {
                const byKey = new Map(current.map((row) => [`${row.source}:${row.id}`, row]));
                moreRows.forEach((row) => byKey.set(`${row.source}:${row.id}`, row));
                return [...byKey.values()].sort((a, b) => b.timestamp - a.timestamp);
            });
            setHasMoreActual(snapshot.docs.length > REPORT_PAGE_SIZE);
            setActualCursor(
                snapshot.docs.length > REPORT_PAGE_SIZE && visible.length
                    ? visible[visible.length - 1]
                    : null
            );
        } catch (err) {
            console.error("Failed loading more packaging rows:", err);
            setError("טעינת העמוד הבא נכשלה");
        } finally {
            setLoadingMore(false);
        }
    }

    function setQuickRange(days: number) {
        const today = new Date();
        setMode("range");
        setStartDate(toDateInputValue(addDays(today, -(days - 1))));
        setEndDate(toDateInputValue(today));
    }

    // ========================================================
    // TOTALS
    // ========================================================

    const totals = useMemo(() => {
        const map = new Map<
            string,
            {
                itemLabel: string;
                unit: string;
                quantity: number;
            }
        >();

        rows.forEach((row) => {
            const key = `${normalizeItemLabel(row.itemLabel)}__${row.unit}`;
            const existing = map.get(key);

            if (existing) {
                existing.quantity += row.quantity;
            } else {
                map.set(key, {
                    itemLabel: row.itemLabel,
                    unit: row.unit,
                    quantity: row.quantity,
                });
            }
        });

        return Array.from(map.values()).sort(
            (a, b) => b.quantity - a.quantity
        );
    }, [rows]);

    const isCurrentWeek =
        mode === "week" &&
        weekStart.getTime() ===
        getWeekStart(new Date()).getTime();

    const currentWeekNumber =
        getNormalizedWeekNumber(weekStart);

    const currentWeekYear =
        getNormalizedWeekYear(weekStart);

    // ========================================================
    // RENDER
    // ========================================================

    return (
        <div className="write-messurmant packaging-report">
            {/* MODE SWITCHER */}
            <div
                className="status-filter"
                style={{ marginBottom: 10 }}
            >
                <button
                    type="button"
                    className={`status-filter-button ${mode === "week"
                        ? "active"
                        : ""
                        }`}
                    onClick={() => setMode("week")}
                >
                    <span>לפי שבוע</span>
                </button>

                <button
                    type="button"
                    className={`status-filter-button ${mode === "range"
                        ? "active"
                        : ""
                        }`}
                    onClick={() => setMode("range")}
                >
                    <span>לפי טווח תאריכים</span>
                </button>
            </div>

            {/* PICKERS */}
            {mode === "week" ? (
                <div className="week-nav">
                    <button
                        type="button"
                        className="week-nav-arrow"
                        onClick={goPrevWeek}
                        aria-label="שבוע קודם"
                    >
                        ‹
                    </button>

                    <div className="week-nav-center">
                        {/* WEEK SELECT */}
                        <select
                            className="packaging-report-input week-select"
                            value={getNormalizedWeekKey(
                                weekStart
                            )}
                            onChange={(e) =>
                                jumpToWeek(
                                    e.target.value
                                )
                            }
                            aria-label="בחירת שבוע"
                        >
                            {weekOptions.map(
                                (week) => {
                                    const key =
                                        getNormalizedWeekKey(
                                            week
                                        );

                                    return (
                                        <option
                                            key={key}
                                            value={key}
                                        >
                                            {formatWeekLabel(
                                                week
                                            )}
                                        </option>
                                    );
                                }
                            )}
                        </select>

                        {/* CURRENT WEEK INFO */}
                        <div className="week-nav-label">
                            שבוע {currentWeekNumber}
                            {" "}
                            ({currentWeekYear})
                            <br />
                            <span>
                                {formatDDMMYYYY(
                                    weekStart
                                )}{" "}
                                –{" "}
                                {formatDDMMYYYY(
                                    addDays(
                                        weekStart,
                                        6
                                    )
                                )}
                            </span>
                        </div>

                        {!isCurrentWeek && (
                            <button
                                type="button"
                                className="week-nav-today"
                                onClick={goThisWeek}
                            >
                                השבוע הנוכחי
                            </button>
                        )}

                        {showWeekJump && (
                            <div className="week-jump-popover">
                                <input
                                    type="date"
                                    defaultValue={toDateInputValue(
                                        weekStart
                                    )}
                                    onChange={(e) =>
                                        jumpToDate(
                                            e.target.value
                                        )
                                    }
                                    className="packaging-report-input"
                                    autoFocus
                                />
                            </div>
                        )}
                    </div>

                    <button
                        type="button"
                        className="week-nav-arrow"
                        onClick={goNextWeek}
                        aria-label="שבוע הבא"
                    // onClick={goPrevWeek}
                    // aria-label="שבוע קודם"
                    >
                        ›
                    </button>
                </div>
            ) : (
                <div className="packaging-report-pickers">
                    <div className="packaging-report-quick-ranges">
                        {[7, 30, 90].map((days) => (
                            <button key={days} type="button" className="btn-secondary" onClick={() => setQuickRange(days)}>
                                {days} ימים
                            </button>
                        ))}
                    </div>
                    <label className="packaging-report-label">
                        מתאריך

                        <input
                            type="date"
                            value={startDate}
                            onChange={(e) =>
                                setStartDate(
                                    e.target.value
                                )
                            }
                            className="packaging-report-input"
                        />
                    </label>

                    <label className="packaging-report-label">
                        עד תאריך

                        <input
                            type="date"
                            value={endDate}
                            onChange={(e) =>
                                setEndDate(
                                    e.target.value
                                )
                            }
                            className="packaging-report-input"
                        />
                    </label>
                </div>
            )}

            {loading && (
                <div className="measurementLoading">
                    <BeerLoader message="טוען נתונים..." size="small" />
                </div>
            )}

            {error && (
                <div className="measurementError">
                    {error}
                </div>
            )}

            {!loading &&
                !error &&
                rows.length === 0 && (
                    <div className="measurementEmpty">
                        אין נתוני אריזה בטווח שנבחר
                    </div>
                )}

            {!loading &&
                !error &&
                rows.length > 0 && (
                    <>
                        <table className="packaging-report-table">
                            <thead>
                                <tr>
                                    <th>תאריך אריזה</th>
                                    <th>תאריך תפוגה</th>
                                    <th>
                                        פריט
                                    </th>
                                    <th>מיכל</th>
                                    <th>
                                        סוג אריזה
                                    </th>
                                    <th>כמות</th>
                                    <th>אצווה</th>
                                    <th>
                                        נארז/בתכנון
                                    </th>
                                </tr>
                            </thead>

                            <tbody>
                                {rows.map((row) => (
                                    <tr
                                        key={row.id}
                                        className={
                                            row.source ===
                                                "estimated"
                                                ? "estimated-row"
                                                : ""
                                        }
                                    >
                                        <td>
                                            {row.date}
                                        </td>

                                        <td>
                                            {
                                                row.expiryDateStr
                                            }
                                        </td>

                                        <td>
                                            {
                                                row.itemLabel
                                            }
                                        </td>
                                            <td>{row.tankNumber}</td>
                                        <td>
                                            {row.unit}
                                        </td>

                                        <td>
                                            {row.quantity}
                                        </td>

                                        <td>
                                            {row.batchNumber ??
                                                "—"}
                                        </td>

                                        <td>
                                            <span
                                                className={`source-badge source-${row.source}`}
                                            >
                                                {row.source ===
                                                    "actual"
                                                    ? "נארז"
                                                    : "בתכנון"}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {hasMoreActual && (
                            <div className="packaging-report-load-more">
                                <button
                                    type="button"
                                    className="btn-secondary"
                                    disabled={loadingMore}
                                    onClick={() => void loadMoreActualRows()}
                                >
                                    {loadingMore ? "טוען…" : "טען עוד"}
                                </button>
                            </div>
                        )}

                        <div className="packaging-report-totals">
                            <div className="packaging-report-totals-title">
                                סיכום לפי פריט
                            </div>

                            <div className="packaging-report-totals-list">
                                {totals.map((t) => (
                                    <div key={`${t.itemLabel}__${t.unit}`} className="packaging-report-total-chip">
                                        <span className="chip-label">{t.itemLabel}</span>
                                        <span className="chip-value">
                                            <span className="chip-unit">{t.unit}</span>
                                            <bdi className="chip-quantity">{t.quantity}</bdi>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                )}
        </div>
    );
}
