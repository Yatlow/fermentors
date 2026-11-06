import BeerLoader from "./../general/Loading";
import { useEffect, useMemo, useRef, useState } from "react";
import { writeReadingsToSheets, type writeReadingResult } from "../../SERVICES/getAndPost/writeReadingToSheets";
import type { Fermentor, NewReading, ReadingToSend } from "../../App";
import type { Measurement } from "../../SERVICES/cellering/calculateCelleringRecomendations";
import HealthDashboard from "../dashboard/HealthDashboard";
import { hotMeasurementRecommendationTanks } from "../../SERVICES/dashboard/cellarGrace";
import {
    dueScheduledForTank,
    setScheduledCellarRecommendationStatus,
    subscribeScheduledCellarRecommendations,
    type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import { updatePackagingInfo } from "../../SERVICES/cellering/updatePackagingInfo";
import { cellarMeasurementWarnings } from "../../SERVICES/cellering/cellarMeasurementWarnings";
import { resolveFinalPackagingTotal } from "../../SERVICES/cellering/resolveFinalPackagingTotal";
import { assignDryHopToHopsTable } from "../../SERVICES/cellering/assignDryHop";
import { getBrewAge } from "../dashboard/TankCard";
import { pushCurrentDataToFirestore } from "../../SERVICES/getAndPost/pushCurrentDataToFirestore";
// ⚠️ שינוי - כבר לא כותבים כאן ישירות לטבלת המאסטר ולא מחכים לה.
// PackagingPalletsModal מפעיל את submitPackagingRecord מיד ברקע דרך usePackagingPalletsFlow,
// ומאפשר למשתמש לערוך את חלוקת המשטחים לפני שהם נוצרים בפועל.
import PackagingPalletsModal from "../cooler/PackagingPalletsModal";
import type { PackagingJobInput } from "../../SERVICES/cooler/usePackagingPalletsFlow";

export type SendMessurmentsHeaderProps = {
    brews: Fermentor[],
    newReadings: Record<string, NewReading>,
    setNewReadings: Function,
    reportName: "לחץ" | "חם" | "פעולות" | "אריזה",
    hasIncompleteNotes?: boolean,
    onResetAll?: () => void,
    specs: SpecChart | null,
}

export default function SendMessurmentsHeader({
    brews,
    newReadings,
    setNewReadings,
    reportName,
    hasIncompleteNotes,
    onResetAll,
    specs,
}: SendMessurmentsHeaderProps) {

    const [sendingReading, setSendingReading] = useState<"idle" | "loading" | "sent" | "error" | "sync" | "getRecs" | "checking">("idle");
    const [confirmMissing, setConfirmMissing] = useState<{ open: boolean; missingTanks: (string | number)[] }>({
        open: false,
        missingTanks: [],
    });
    const [confirmMeassurments, setConfirmMessurments] = useState<{ open: boolean; unvalidMessurments: (string | number)[] }>({
        open: false,
        unvalidMessurments: []
    });
    const [sendResults, setSendResults] = useState<writeReadingResult[]>([]);
    const [showSendStatus, setShowSendStatus] = useState(false);
    const [scheduledRecommendations, setScheduledRecommendations] = useState<ScheduledCellarRecommendation[]>([]);
    // Only the post-sugar/pH confirmation modal is limited to warm tanks.
    // The full cellar dashboard and the pressure-report modal remain unchanged.
    const recommendationBrews = useMemo(
        () => reportName === "חם" ? hotMeasurementRecommendationTanks(brews) : brews,
        [brews, reportName],
    );

    // חדש: מתריע אם הכתיבה בפועל לגיליון נכשלה ברקע, אחרי שכבר הוצגו המלצות למשתמש
    const [writeWarning, setWriteWarning] = useState<writeReadingResult[] | null>(null);

    // ⚠️ חדש - דיווחי אריזה שממתינים לעריכת חלוקת משטחים (ר' PackagingPalletsModal)
    const [packagingJobs, setPackagingJobs] = useState<PackagingJobInput[] | null>(null);



    const scrollRef = useRef<HTMLDivElement>(null);
    const sendInFlightRef = useRef(false);
    const [showScrollHint, setShowScrollHint] = useState(false);

    const checkScrollState = () => {
        const el = scrollRef.current;
        if (!el) return;
        const hasMoreToScroll =
            el.scrollHeight - el.scrollTop - el.clientHeight > 10;
        setShowScrollHint(hasMoreToScroll);
    };

    useEffect(() => {
        return subscribeScheduledCellarRecommendations(
            setScheduledRecommendations,
            (error) => console.error("Failed loading scheduled cellar recommendations:", error),
        );
    }, []);

    useEffect(() => {
        checkScrollState();
    }, [sendingReading, sendResults]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(checkScrollState);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    async function fetchAllTankMeasurements(fullTanks: Fermentor[]) {
        const entries = await Promise.all(
            fullTanks.map(async (tank) => {
                const messurments = await getMeasurementsByBatch(tank.batchNumber ?? "");
                return [String(tank.tankNumber), messurments] as const;
            })
        );
        return Object.fromEntries(entries);
    }

    const handleSendClick = () => {
        const missing = getMissingTanks();
        if (missing.length > 0) {
            setConfirmMissing({ open: true, missingTanks: missing });
            return;
        }
        if (reportName === "חם" || reportName === "לחץ") {
            void getUnvalidMessurments();
        } else {
            void sendReadings()
        }
    };

    const handleRecClick = () => {
        setShowSendStatus(false);
        if (!specs) return;
        // The metric itself is the sole source of truth and visual presentation.
        setSendingReading("sent");
    };

    function buildMeasurementId(date: Date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const mm = String(date.getMinutes()).padStart(2, "0");
        return `${y}-${m}-${d}_${hh}${mm}`;
    };

    async function resolveScheduledActionsForSuccessfulReadings(
        readings: ReadingToSend[],
        results: writeReadingResult[]
    ) {
        const completedIds = new Set<string>();

        for (const reading of readings) {
            const result = results.find(
                (candidate) => String(candidate.tankId) === String(reading.tankId)
            );
            if (result?.success === false) continue;

            const tank = brews.find((candidate) => String(candidate.id) === String(reading.tankId));
            if (!tank?.batchNumber) continue;

            const noteText = String(reading.notes ?? "");
            const performed = new Set<"carbTest" | "yeastDrop">();

            if (
                reading.carbonation !== undefined &&
                reading.carbonation !== null &&
                reading.carbonation !== ""
            ) {
                performed.add("carbTest");
            }
            if (/בדיקת\s+גיזוז/.test(noteText)) performed.add("carbTest");
            if (/שמרים|שמרי/.test(noteText)) performed.add("yeastDrop");
            if (performed.size === 0) continue;

            const due = dueScheduledForTank(
                scheduledRecommendations,
                tank.tankNumber,
                tank.batchNumber,
            );

            for (const row of due) {
                if (!performed.has(row.actionType) || completedIds.has(row.id)) continue;
                await setScheduledCellarRecommendationStatus(row.id, "completed");
                completedIds.add(row.id);
            }
        }
    }

    const sendReadings = async () => {
        if (sendInFlightRef.current) return;
        sendInFlightRef.current = true;
        setShowSendStatus(true)
        setConfirmMissing({ open: false, missingTanks: [] });
        setConfirmMessurments({ open: false, unvalidMessurments: [] });
        setWriteWarning(null);

        let readingsToSend = brews
            .filter((fv) => Number(fv.tankNumber) !== 1)
            .map((fv) => {
                const reading = newReadings[fv.id] ?? {};
                return {
                    ...reading,
                    id: buildMeasurementId(),
                    tankId: fv.id,
                    tankNumber: fv.tankNumber,
                    batchNumber: fv.batchNumber,
                    sheetUrl: fv.sheetUrl ?? null,
                    boldNotes: reportName === "אריזה" ? true : undefined,
                };
            })
            .filter((reading) => {
                if (reportName === "אריזה") {
                    return (
                        reading.isEmpty !== undefined ||
                        reading.kegs !== undefined ||
                        reading.crates !== undefined ||
                        reading.notes !== undefined
                    );
                }

                return (
                    reading.temp !== undefined ||
                    reading.pressure !== undefined ||
                    reading.pH !== undefined ||
                    reading.plato !== undefined ||
                    reading.carbonation !== undefined ||
                    reading.notes !== undefined
                );
            });

        let packagingEntries: any[] = [];
        if (reportName === "אריזה") {
            setSendingReading("loading")
            const enrichedReadings = await Promise.all(
                readingsToSend.map(async (r) => {
                    const tank = brews.find((b) => b.id === r.tankId);

                    const isEmpty = (r as any).isEmpty === true;

                    let totalLiters: number | undefined;
                    let shrinkagePercent: number | undefined;

                    if (isEmpty && tank) {

                        const reportLiters =
                            Number((r as any).kegs || 0) +
                            Number((r as any).crates || 0);

                        const result =
                            await resolveFinalPackagingTotal(
                                (r as any).kegs
                                    ? "kegs"
                                    : "bottles",
                                tank,
                                reportLiters
                            );

                        totalLiters = result.totalLiters;
                        shrinkagePercent =
                            result.shrinkagePercent ?? undefined;

                        const shrinkageText =
                            shrinkagePercent !== undefined
                                ? `סה"כ ${totalLiters.toFixed(2)} ליטר , פחת ${shrinkagePercent.toFixed(2)}%`
                                : `סה"כ ${totalLiters.toFixed(2)} ליטר`;

                        const existingNotes =
                            (r as any).notes as string | undefined;

                        r = {
                            ...r,
                            kegs: (r as any).kegs,
                            crates: (r as any).crates,
                            totalLiters,
                            shrinkagePercent,
                            notes: existingNotes
                                ? `${existingNotes}, ${shrinkageText}`
                                : shrinkageText,
                        };
                    }

                    packagingEntries.push({
                        tankId: r.tankId,
                        tankNumber: (r as any).tankNumber,
                        sheetUrl: r.sheetUrl,
                        isEmpty: (r as any).isEmpty,
                        kegs: (r as any).kegs,
                        crates: (r as any).crates,
                        totalLiters,
                        shrinkagePercent,
                    });

                    return r;
                })

            );

            readingsToSend = enrichedReadings;

            // ⚠️ שינוי מרכזי: לא כותבים יותר לטבלת המאסטר כאן ולא מחכים (await) לה -
            // זה בדיוק מה שגרם להמתנה הארוכה. במקום זה בונים רשימת "עבודות אריזה"
            // ופותחים איתה את PackagingPalletsModal, שמפעיל את הכתיבה מיד ברקע
            // (דרך usePackagingPalletsFlow) ובמקביל מציג למשתמש את חלוקת המשטחים לעריכה.
            const jobs: PackagingJobInput[] = packagingEntries
                .filter((e: any) => Number(e.kegs) > 0 || Number(e.crates) > 0)
                .map((e: any) => {
                    const tank = brews.find((b) => b.id === e.tankId);
                    const packagingType: "kegs" | "bottles" = Number(e.kegs) > 0 ? "kegs" : "bottles";
                    // עיגול: הכמות בליטרים משוחזרת לכמות שלמה של חביות/ארגזים, ו-0.33
                    // (BOTTLE_LITERS) לא ניתן לייצוג מדויק ב-binary float - בלי עיגול
                    // חבילה בגודל בדיוק ארגז יכולה לצאת 47.999... ולחתוך ארגז שלם בטעות.
                    const rawAmount = Math.round(
                        packagingType === "kegs"
                            ? Number(e.kegs) / 20 // KEG_LITERS
                            : Number(e.crates) / 0.33 // BOTTLE_LITERS
                    );
                    return {
                        submissionId: crypto.randomUUID(),
                        tankId: e.tankId,
                        tankNumber: e.tankNumber,
                        beerStyle: tank?.beerStyle,
                        packagingType,
                        amount: rawAmount,
                        batchNumber: tank?.batchNumber ?? null,
                        tankStatus: Boolean(e.isEmpty),
                    };
                });

            if (jobs.length > 0) {
                setPackagingJobs(jobs);
                // ⚠️ חדש - מייד מסירים את המודל הכללי (הישן) של הקומפוננטה הזו,
                // כדי ש-PackagingPalletsModal יהיה המודל היחיד על המסך. בלי זה,
                // אם sendingReading עדיין "loading"/"error" בהמשך, שני המודלים
                // היו נפתחים אחד מעל השני.
                setSendingReading("idle");
            }
        }

        const isFastPath = reportName === "חם" || reportName === "לחץ";

        // ------------------------------------------------------------
        // מתחילים את הכתיבה בפועל לגיליון, אבל לא מחכים לה עדיין.
        // ה-catch כאן חשוב: מונע "Unhandled promise rejection" כי
        // אנחנו מטפלים בתוצאה של ה-promise רק בהמשך, למטה.
        // ------------------------------------------------------------
        // ⚠️ שינוי: אם כבר נפתח מודל המשטחים (jobs.length > 0), לא דורסים
        // בחזרה את sendingReading ל-"loading"/"getRecs" - זה יפתח שוב את
        // המודל הכללי מעל PackagingPalletsModal.
        const alreadyHandedToPalletsModal = reportName === "אריזה" && packagingEntries.some(
            (e: any) => Number(e.kegs) > 0 || Number(e.crates) > 0
        );
        if (!alreadyHandedToPalletsModal) {
            setSendingReading(isFastPath ? "getRecs" : "loading");
        }
        const writePromise = writeReadingsToSheets(readingsToSend).catch((error) => {
            console.error("writeReadingsToSheets failed:", error);
            return null; // מסמן כשל, מטופל למטה
        });

        // ------------------------------------------------------------
        // מסלול מהיר: לחץ/חם — מחשבים ומציגים המלצות מיד,
        // בלי לחכות שהכתיבה בפועל תסתיים.
        // ------------------------------------------------------------
        if (isFastPath && specs) {
            // The shared HealthDashboard listens to measurement cache updates.
            // Never compute a second, inconsistent list of recommendations here.
            setSendingReading("sent");
            setNewReadings({});
        }

        // ------------------------------------------------------------
        // הכתיבה בפועל ממשיכה ברקע. כשהיא מסתיימת (הצלחה או כישלון),
        // מטפלים בתוצאות בלי לחסום את מה שכבר הוצג למשתמש.
        // ------------------------------------------------------------
        writePromise.then(async (res) => {

            if (!res) {
                // הכתיבה נכשלה לגמרי (למשל timeout/רשת)
                setSendResults([]);
                if (isFastPath) {
                    setWriteWarning([{ success: false, tankId: "", error: "השליחה לשרת נכשלה" } as writeReadingResult]);
                } else if (!alreadyHandedToPalletsModal) {
                    setSendingReading("error");
                }
                return;
            }

            setSendResults(res);
            if (reportName === "פעולות") {
                const dryHopEntries = readingsToSend.filter(
                    (r) => (r as any).dryHopGrams && (r as any).dryHopType && (r as any).dryHopAa
                );

                if (dryHopEntries.length > 0) {
                    await Promise.all(
                        dryHopEntries.map(async (r) => {
                            if (!r.sheetUrl) return;
                            try {
                                await assignDryHopToHopsTable(
                                    String(r.sheetUrl),
                                    Number((r as any).dryHopGrams),
                                    String((r as any).dryHopType),
                                    Number((r as any).dryHopAa)
                                );
                            } catch (error) {
                                console.error(
                                    "Failed to assign dry hop to hops table for tank",
                                    r.tankId,
                                    error
                                );
                            }
                        })
                    );
                }
            }
            if (reportName === "אריזה") {
                try {

                    const packagingResults = await updatePackagingInfo(packagingEntries);
                    const withWarnings = packagingResults.filter(
                        (r: any) => r.warnings && r.warnings.length > 0
                    );
                    if (withWarnings.length > 0) {
                        console.warn("Packaging update partial warnings:", withWarnings);
                    }
                } catch (error) {
                    console.error("Failed to update packaging info:", error);
                }
            }

            const succeededReadings = readingsToSend.flatMap((reading) => {
                const result = res.find(
                    (item) => String(item.tankId) === String(reading.tankId)
                );

                // אם השרת החזיר כשל מפורש למיכל - לא מעדכנים Firestore.
                // תשובה כללית תקינה שלא כוללת tankId עדיין מאפשרת לעדכן את
                // currentData המקומי (למשל totalLiters של אריזה סופית).
                if (result?.success === false) return [];

                return [{
                    ...reading,
                    sheetResult: result?.result,
                }];
            });

            try {
                await pushCurrentDataToFirestore(succeededReadings);
            } catch (error) {
                console.error(
                    "The Sheet was updated, but the realtime Firestore update failed:",
                    error
                );
            }

            const allSucceeded = res.every((r) => r.success);
            // The durable Firestore write has been acknowledged by writeReadingsToSheets.
            // Sheet synchronization continues asynchronously and is tracked separately.
            if (allSucceeded && succeededReadings.length > 0) {
                const tankNumbers = [...new Set(succeededReadings.map(reading => String(reading.tankNumber ?? reading.tankId)))];
                window.dispatchEvent(new CustomEvent("cellar-report-saved", {
                    detail: {
                        tankNumber: tankNumbers[0],
                        tankNumbers,
                        label: tankNumbers.length === 1 ? `מיכל ${tankNumbers[0]}` : `${tankNumbers.length} מיכלים`,
                        action: reportName === "לחץ" ? "טמפרטורה ולחץ" : reportName === "חם" ? "פלאטו ו־pH" : reportName === "פעולות" ? "פעולות סלרינג" : "אריזה",
                    },
                }));
            }


            try {
                await resolveScheduledActionsForSuccessfulReadings(readingsToSend, res);
            } catch (error) {
                console.error("Failed resolving scheduled cellar recommendations:", error);
            }

            if (isFastPath) {
                // ההמלצות כבר הוצגו למשתמש קודם. כאן רק מוסיפים אזהרה אם צריך.
                if (!allSucceeded) {
                    setWriteWarning(res.filter((r) => !r.success));
                }
            } else if (!alreadyHandedToPalletsModal) {
                // פעולות/אריזה ללא משטחים: אין מסלול מהיר, מחכים כרגיל לתוצאה הסופית.
                // אם כן נפתח PackagingPalletsModal - הוא מנהל את מצב הסיום בעצמו,
                // ולא נוגעים כאן ב-sendingReading/newReadings.
                setNewReadings({});
                setSendingReading(allSucceeded ? "idle" : "error");
            } else {
                setNewReadings({});
            }
        }).finally(() => {
            sendInFlightRef.current = false;
        });
    };

    const closeStatusModal = () => {
        setSendingReading("idle");
        setSendResults([]);
        setWriteWarning(null);
    };

    function getMissingTanks(): (string | number)[] {
        if (reportName === "פעולות") return [];
        if (reportName === "אריזה") return [];

        if (reportName === "לחץ") {
            return brews
                .filter(
                    (fv) =>
                        Number(fv.tankNumber) !== 1 &&
                        Number(fv.action) === 1
                )
                .filter((fv) => {
                    const r = newReadings[fv.id] ?? {};

                    const tempMissing =
                        r.temp === undefined || r.temp === "";

                    const pressureMissing =
                        r.pressure === undefined || r.pressure === "";

                    return tempMissing || pressureMissing;
                })
                .map((fv) => fv.tankNumber)
                .filter(
                    (tankNumber): tankNumber is string | number =>
                        tankNumber !== null && tankNumber !== undefined
                );
        }

        if (reportName === "חם") {
            return brews
                .filter(
                    (fv) =>
                        Number(fv.tankNumber) !== 1 &&
                        Number(fv.action) === 1 &&
                        Number(fv.currentData?.temp) > 9 &&
                        (getBrewAge(fv?.brewDate) ?? 0) > 0
                )
                .filter((fv) => {
                    const r = newReadings[fv.id] ?? {};

                    const platoMissing =
                        r.plato === undefined || r.plato === "";

                    const pHMissing =
                        r.pH === undefined || r.pH === "";

                    return platoMissing || pHMissing;
                })
                .map((fv) => fv.tankNumber)
                .filter(
                    (tankNumber): tankNumber is string | number =>
                        tankNumber !== null && tankNumber !== undefined
                );
        }

        return [];
    };

    async function getUnvalidMessurments() {
        setSendingReading("checking")
        const invalidText: string[] = []
        // Validate only tanks with entered values for this report. Do not fetch
        // measurement histories for unrelated active tanks.
        const fields = reportName === "לחץ" ? ["temp", "pressure"] : ["plato", "pH"];
        const hasReportedValue = (tank: Fermentor) => {
            const reading = newReadings[tank.id] ?? {};
            return fields.some((field) => {
                const value = reading[field as keyof typeof reading];
                return value !== undefined && value !== null && value !== "";
            });
        };
        let fullTanks = brews.filter((fv) =>
            Number(fv.tankNumber) !== 1 &&
            Number(fv.action) === 1 &&
            Boolean(fv.batchNumber) &&
            hasReportedValue(fv)
        );
        if (reportName === "חם") fullTanks = fullTanks.filter((fv) => fv.stage?.name === "חם" || Number(fv.currentData?.temp) > 9);
        try {
            const byTank = await fetchAllTankMeasurements(fullTanks);
            const readingsToCheck = fullTanks
                .map((fv) => {
                    if (!fv.tankNumber) return null;
                    return {
                        tankNumber: fv.tankNumber,
                        new: newReadings[fv.id] ?? {},
                        current: fv.currentData,
                        previus: byTank[String(fv.tankNumber)],
                        brewDate: fv.brewDate,
                    };
                })
                .filter((r): r is NonNullable<typeof r> => r !== null);
            readingsToCheck.map((readingSet) => {
                const previusMeasurements = readingSet.previus ?? [];
                const sortedMeasurements = [...previusMeasurements].sort((a, b) => {
                    const dateA = String(a.id ?? "");
                    const dateB = String(b.id ?? "");
                    return dateA.localeCompare(dateB);
                });

                if (sortedMeasurements.length < 2) {
                    return;
                }

                const yesterdayMeasurement: Measurement =
                    sortedMeasurements[sortedMeasurements.length - 1];
                invalidText.push(...cellarMeasurementWarnings(
                    readingSet.tankNumber,
                    readingSet.new,
                    readingSet.current ?? {},
                    {
                        previousNotes: String(yesterdayMeasurement?.notes ?? ""),
                        checkCoolingAction: true,
                        checkPressureActions: true,
                        brewAge: getBrewAge(readingSet.brewDate) ?? 0,
                    },
                ));

            })
            if (invalidText.length > 0) {
                setSendingReading("idle")
                setConfirmMessurments({ open: true, unvalidMessurments: invalidText })
            } else {
                setSendingReading("getRecs")
                void sendReadings()
            }
        } catch (error) {
            void sendReadings()
        }
    };

    let canSend = brews.filter((fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1 && (reportName === "לחץ" ? true : Number(fv.currentData?.temp) > 9)).length === getMissingTanks()?.length;
    if (reportName === "פעולות") {
        canSend = Object.keys(newReadings).length < 1 || !!hasIncompleteNotes;
    }

    return (
        <>
            <div className="volumeCounter">
                <div className={`send-messurment ${(canSend) ? "disabled-send" : ""}`}
                    onClick={() => {
                        onResetAll?.();
                        handleSendClick()
                    }}>
                    שלח נתונים
                </div>
                <div className="send-messurment"
                    onClick={() => {
                        onResetAll?.();
                        setNewReadings({})
                    }}>
                    אפס נתונים
                </div>
                <div className={`send-messurment`}
                    onClick={() => handleRecClick()}>
                    הצג המלצות סלרינג
                </div>
            </div>
            {confirmMissing.open && (
                <div className="modal-overlay">
                    <div className="modal-box">
                        <p>
                            {reportName === "לחץ" ?
                                `המיכלים הבאים מסומנים כמלאים אך חסרים בהם נתוני קריאה:${" "}`
                                : `המיכלים הבאים מסומנים כתוססים אך חסרים בהם נתוני קריאה:${" "}`
                            }
                            <span>{confirmMissing.missingTanks.join(", ")}</span>
                        </p>
                        <p>האם אתה בטוח שברצונך לשלוח בכל זאת?</p>
                        <div className="modal-actions">
                            <button
                                className="btn-secondary"
                                onClick={() => setConfirmMissing({ open: false, missingTanks: [] })}
                            >
                                סגור
                            </button>
                            <button className="btn-primary" onClick={() => void getUnvalidMessurments()}>
                                אישור ושליחה
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {confirmMeassurments.open && (
                <div className="modal-overlay">
                    <div className="modal-box">
                        {confirmMeassurments.unvalidMessurments.map((txt, i) => (
                            <div key={i}>• {txt}</div>
                        ))}
                        <p></p>
                        <p>האם אתה בטוח שברצונך לשלוח בכל זאת?</p>
                        <div className="modal-actions">
                            <button
                                className="btn-secondary"
                                onClick={() => {
                                    setConfirmMessurments({ open: false, unvalidMessurments: [] })
                                    setConfirmMissing({ open: false, missingTanks: [] })
                                }}
                            >
                                סגור
                            </button>
                            <button className="btn-primary" onClick={() => void sendReadings()}>
                                אישור ושליחה
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {sendingReading !== "idle" && (
                <div className="modal-overlay">
                    <div className="modal-box">

                        {sendingReading === "loading" && <BeerLoader message="שולח נתונים..." size="medium" />}
                        {sendingReading === "sync" && <BeerLoader message="מרענן נתוני שרת..." size="medium" />}
                        {sendingReading === "getRecs" && <BeerLoader message="טוען המלצות סלרינג..." size="medium" />}
                        {sendingReading === "checking" && <BeerLoader message="בודק תקינות נתונים..." size="medium" />}
                        <div className="modal-box-scroll"
                            ref={scrollRef}
                            onScroll={checkScrollState}>
                            {sendingReading === "sent" && (
                                <div className="sentBox">
                                    <div className="btn-close-modal-Box">
                                        <button
                                            className="btn-close-modal"
                                            onClick={closeStatusModal}
                                        >
                                            X
                                        </button>
                                    </div>
                                    <div className="status-sent">
                                        {showSendStatus && (
                                            <p>
                                                {sendResults.length > 0
                                                    ? "הנתונים נשלחו בהצלחה"
                                                    : "שולח נתונים..."
                                                }
                                            </p>
                                        )}
                                        <p>המלצות ופעולות מעודכנות לפי מדד הסלרינג.</p>

                                    </div>

                                    {writeWarning && (
                                        <div className="write-warning-banner">
                                            <p>שים לב: השמירה בפועל לגיליון עדיין מתבצעת או נכשלה עבור {writeWarning.length} מיכלים.</p>
                                            <button className="btn-secondary" onClick={() => void sendReadings()}>
                                                נסה שוב
                                            </button>
                                        </div>
                                    )}

                                    <HealthDashboard brews={recommendationBrews} specs={specs} recommendationsOnly compactRecommendations />

                                    <p>{""}</p>
                                </div>
                            )}
                        </div>

                        {sendingReading === "error" && (
                            <>
                                <p className="status-error">אירעה שגיאה בשליחת הנתונים ❌</p>
                                {sendResults.length > 0 && (
                                    <ul className="send-results-list">
                                        {sendResults.map((r, i) => (
                                            <li key={i}>
                                                מיכל {String(r.tankId)}: {r.success ? "הצליח" : r.error ?? r.message ?? "נכשל"}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <button className="btn-primary" onClick={closeStatusModal}>
                                    סגור
                                </button>
                            </>
                        )}
                        <div className={`modal-scroll-hint ${showScrollHint ? "" : "hidden"}`}>
                            <span className="modal-scroll-arrow">⌄</span>
                        </div>
                    </div>
                </div>
            )}

            {packagingJobs && (
                <PackagingPalletsModal
                    jobs={packagingJobs}
                    onFinished={() => setPackagingJobs(null)}
                />
            )}
        </>
    )
}
