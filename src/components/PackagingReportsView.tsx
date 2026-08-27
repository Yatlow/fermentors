// components/PackagingReportsView.tsx

import { useEffect, useMemo, useState } from "react";
import {
    collection,
    getDocs,
    query,
    where,
    orderBy,
} from "firebase/firestore";
import { db } from "../firebase";

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
};

type CalendarEventDoc = {
    date?: string;
    timestamp?: number;
    itemType?: string;
    unit?: string;
    quantity?: number;
    actionType?: string;
    title?: string;
    tankNumber?:string|number;

    // מספר המיכל המתוכנן לאריזה
    containerNumber?: string | number | null;
};

/** actionType בקולקציית calendar_events שמייצג אירוע אריזה/הורדה עתידית */
const PACKAGING_ACTION_TYPE = "הורדה";

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

/**
 * מפתח ייחודי לשבוע.
 *
 * לדוגמה:
 * 2026-W35
 */
export function getNormalizedWeekKey(weekStart: Date): string {
    const year = getNormalizedWeekYear(weekStart);
    const week = getNormalizedWeekNumber(weekStart);

    return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * תצוגת שבוע:
 *
 * שבוע 35 · 23/08/2026 – 29/08/2026
 */
export function formatWeekLabel(weekStart: Date): string {
    const start = getWeekStart(weekStart);
    const end = addDays(start, 6);

    const weekNumber = getNormalizedWeekNumber(start);

    return `שבוע ${weekNumber} · ${formatDDMMYYYY(start)} – ${formatDDMMYYYY(end)}`;
}

// ============================================================
// WEEK SELECT OPTIONS
// ============================================================

/**
 * מחזיר את כל השבועות שמתחילים ביום ראשון
 * עבור שנה נתונה.
 *
 * אנחנו משתמשים בטווח רחב מעט כדי שגם שבועות שחוצים שנה
 * יופיעו בצורה נכונה.
 */
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

/**
 * בונה רשימת שבועות לבחירה:
 * שנה קודמת + השנה הנוכחית + השנה הבאה.
 *
 * כך אפשר גם לעבור ב-SELECT בין סוף שנה לתחילת שנה.
 */
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

// ============================================================
// NEXT WEEK PACKAGING CONTAINERS
// ============================================================

/**
 * מחזירה את מספרי המיכלים שמתוכננים לאריזה בשבוע הבא.
 *
 * המקור:
 * calendar_events
 *
 * התנאי:
 * actionType === "הורדה"
 *
 * השדה שמכיל את מספר המיכל:
 * containerNumber
 *
 * דוגמה:
 * const containers = await getPlannedPackagingContainerNumbers();
 *
 * // ["101", "104", "108"]
 */
export async function getPlannedPackagingContainerNumbers(): Promise<number[]> {
    const currentWeekStart = getWeekStart(new Date());
    const nextWeekStart = addDays(currentWeekStart, 7);
    const nextWeekEnd = toEndOfDay(addDays(nextWeekStart, 6));

    const snapshot = await getDocs(
        query(
            collection(db, "calendar_events"),
            where("actionType", "==", PACKAGING_ACTION_TYPE),
            where("timestamp", ">=", nextWeekStart.getTime()),
            where("timestamp", "<=", nextWeekEnd.getTime()),
            orderBy("timestamp", "asc")
        )
    );

    const tankNumbers = snapshot.docs
        .map((doc) => {
            const data = doc.data() as CalendarEventDoc;

            return data.tankNumber;
        })
        .filter(
            (tankNumber): tankNumber is number =>
                typeof tankNumber === "number"
        );

    // הסרת כפילויות
    return [...new Set(tankNumbers)];
}




// ============================================================
// COMPONENT
// ============================================================

export default function PackagingReportsView() {
    const [mode, setMode] = useState<RangeMode>("week");

    const [startDate, setStartDate] = useState<string>(
        todayInputValue()
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
            return;
        }

        let cancelled = false;

        setLoading(true);
        setError(null);

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
                        orderBy("timestamp", "asc")
                    )
                );

                // אירועים עתידיים/מוערכים
                const estimatedStartTs = Math.max(
                    startTs,
                    now
                );

                const shouldLoadEstimated = endTs >= now;

                const estimatedRowsPromise = shouldLoadEstimated
                    ? getDocs(
                          query(
                              collection(db, "calendar_events"),
                              where(
                                  "actionType",
                                  "==",
                                  PACKAGING_ACTION_TYPE
                              ),
                              where(
                                  "timestamp",
                                  ">=",
                                  estimatedStartTs
                              ),
                              where(
                                  "timestamp",
                                  "<=",
                                  endTs
                              ),
                              orderBy(
                                  "timestamp",
                                  "asc"
                              )
                          )
                      )
                    : Promise.resolve(null);

                const [
                    actualSnap,
                    estimatedSnap,
                ] = await Promise.all([
                    actualRowsPromise,
                    estimatedRowsPromise,
                ]);

                if (cancelled) {
                    return;
                }

                const actualRows: PackagingRow[] =
                    actualSnap.docs.map((d) => {
                        const data =
                            d.data() as PackagingLogDoc;

                        return {
                            id: d.id,
                            date: data.date ?? "",
                            timestamp:
                                data.timestamp ?? 0,
                            expiryDateStr:
                                data.expiryDateStr ?? "",
                            itemLabel:
                                data.beerStyle ?? "",
                            packagingType:
                                data.packagingType ?? null,
                            unit:
                                data.unit ??
                                (data.packagingType ===
                                "kegs"
                                    ? "חביות"
                                    : "ארגזים"),
                            quantity: Number(
                                data.quantity ?? 0
                            ),
                            batchNumber:
                                data.batchNumber,
                            source: "actual",
                        };
                    });

                const estimatedRows: PackagingRow[] =
                    estimatedSnap
                        ? estimatedSnap.docs.map((d) => {
                              const data =
                                  d.data() as CalendarEventDoc;

                              return {
                                  id: d.id,
                                  date:
                                      data.date ?? "",
                                  timestamp:
                                      data.timestamp ??
                                      0,
                                  expiryDateStr: "",
                                  itemLabel:
                                      data.itemType ??
                                      data.title ??
                                      "",
                                  packagingType: null,
                                  unit:
                                      data.unit ?? "",
                                  quantity: Number(
                                      data.quantity ?? 0
                                  ),
                                  batchNumber: null,
                                  source: "estimated",
                              };
                          })
                        : [];

                const merged = [
                    ...actualRows,
                    ...estimatedRows,
                ].sort(
                    (a, b) =>
                        a.timestamp - b.timestamp
                );

                setRows(merged);
            } catch (err: any) {
                console.error(
                    "Failed loading packaging report:",
                    err
                );

                if (!cancelled) {
                    setError(
                        "שגיאה בטעינת הדוח. ייתכן שנדרש אינדקס בפיירסטור - בדוק את הקונסול לקישור ליצירתו."
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        load();

        return () => {
            cancelled = true;
        };
    }, [range]);

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
            const key = `${row.itemLabel}__${row.unit}`;
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
                    className={`status-filter-button ${
                        mode === "week"
                            ? "active"
                            : ""
                    }`}
                    onClick={() => setMode("week")}
                >
                    <span>לפי שבוע</span>
                </button>

                <button
                    type="button"
                    className={`status-filter-button ${
                        mode === "range"
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
                    טוען נתונים...
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
                                        פריט / סגנון
                                    </th>
                                    <th>
                                        סוג אריזה
                                    </th>
                                    <th>כמות</th>
                                    <th>אצווה</th>
                                    <th>
                                        נארז/ביומן
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
                                                    : "ביומן"}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <div className="packaging-report-totals">
                            <div className="packaging-report-totals-title">
                                סיכום לפי פריט
                            </div>

                            <div className="packaging-report-totals-list">
                                {totals.map((t) => (
                                    <div
                                        key={`${t.itemLabel}__${t.unit}`}
                                        className="packaging-report-total-chip"
                                    >
                                        <span className="chip-label">
                                            {
                                                t.itemLabel
                                            }
                                        </span>

                                        <span className="chip-value">
                                            {
                                                t.quantity
                                            }{" "}
                                            {t.unit}
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
