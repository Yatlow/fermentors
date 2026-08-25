import { useEffect, useRef, useState } from "react";
import { writeReadingsToSheets, type writeReadingResult } from "../SERVICES/writeReadingToSheets";
import type { Fermentor, NewReading } from "../App";
import { calcCelleringRecomendations, type Measurement } from "../SERVICES/calculateCelleringRecomendations";
import { getSpecsFromFb, type SpecChart } from "../SERVICES/getSpecsFromFb";
import { getMeasurementsByBatch } from "../SERVICES/gettAllDataByBatch";
import { updatePackagingInfo } from "../SERVICES/updatePackagingInfo";
import { resolveFinalPackagingTotal } from "../SERVICES/resolveFinalPackagingTotal";
import { assignDryHopToHopsTable } from "../SERVICES/assignDryHop";
import { getBrewAge } from "./TankCard";
import { pushCurrentDataToFirestore } from "../SERVICES/pushCurrentDataToFirestore";

export type SendMessurmentsHeaderProps = {
    brews: Fermentor[],
    newReadings: Record<string, NewReading>,
    setNewReadings: Function,
    reportName: "לחץ" | "חם" | "פעולות" | "אריזה",
    hasIncompleteNotes?: boolean,
    onResetAll?: () => void,
}

type RecommendationsByTank = Record<
    string,
    Awaited<ReturnType<typeof calcCelleringRecomendations>> | null
>;

type Recommendation = {
    req: boolean;
    reason?: string;
    importance: number;
    display: boolean;
};

export default function SendMessurmentsHeader({
    brews,
    newReadings,
    setNewReadings,
    reportName,
    hasIncompleteNotes,
    onResetAll,
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
    const [specs, setSpecs] = useState<SpecChart | null>(null);
    const [rcs, setRcs] = useState<RecommendationsByTank>({});

    const measurementsCache = useRef<Record<string, Measurement[]>>({});

    const scrollRef = useRef<HTMLDivElement>(null);
    const [showScrollHint, setShowScrollHint] = useState(false);

    const checkScrollState = () => {
        const el = scrollRef.current;
        if (!el) return;
        const hasMoreToScroll =
            el.scrollHeight - el.scrollTop - el.clientHeight > 10;
        setShowScrollHint(hasMoreToScroll);
    };

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
        measurementsCache.current = Object.fromEntries(entries);
        return measurementsCache.current;
    }

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

    const handleRecClick = async () => {
        if (!specs) {
            console.warn("Specs are not loaded yet");
            return;
        }
        try {
            try {
                setSendingReading("getRecs")
                const getRecs = async () => {
                    const fullTanks = brews.filter((fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1);
                    const entries = await Promise.all(
                        fullTanks.map(async (tank: Fermentor) => {
                            const messurments = await getMeasurementsByBatch(tank.batchNumber ?? "");
                            if (!tank.stage) {
                                console.warn(
                                    "Cannot calculate recommendations: tank stage is missing",
                                    tank.id,
                                    tank.tankNumber
                                );

                                return [tank.tankNumber, null] as const;
                            }
                            const rec = await calcCelleringRecomendations(
                                messurments,
                                tank?.beerStyle,
                                tank?.batchNumber ?? "",
                                tank?.brewDate ?? "",
                                specs,
                                tank.stage
                            ).catch((err) => {
                                console.error("Failed for tank", tank.id, tank.tankNumber, err);
                                return null;
                            });
                            return [tank.tankNumber, rec] as const;
                        })
                    );

                    const recomendations: RecommendationsByTank =
                        Object.fromEntries(entries);

                    return recomendations;
                };
                const recommendations = await getRecs();

                setRcs(recommendations);
                setSendingReading(Object.keys(recommendations).length ? "sent" : "error");
            } catch (error) {
                console.error("Failed to update database:", error);
            }
        } catch (error) {
            setSendResults([]);
            setSendingReading("error");
        }
    };

    function buildMeasurementId(date: Date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const mm = String(date.getMinutes()).padStart(2, "0");
        return `${y}-${m}-${d}_${hh}${mm}`;
    };

    function mergeReadingIntoMeasurements(
        measurements: Measurement[],
        newReading: Measurement
    ): Measurement[] {
        const newId = newReading.id ?? buildMeasurementId();

        const newDateKey = String(newId).split("_")[0];

        const sameDayMeasurements = measurements.filter((m) =>
            String(m.id).startsWith(`${newDateKey}_`)
        );

        const previousToday = sameDayMeasurements
            .slice()
            .sort((a, b) =>
                String(a.id).localeCompare(String(b.id))
            )
            .at(-1);

        const mergedReading: Measurement = {
            ...(previousToday ?? {}),
            ...newReading,
            id: newId,
        };

        // undefined = לא נשלח → שומרים את הערך הקודם
        if (previousToday) {
            (Object.keys(previousToday) as (keyof Measurement)[]).forEach(
                (key) => {
                    if (mergedReading[key] === undefined) {
                        mergedReading[key] = previousToday[key];
                    }
                }
            );
        }

        const withoutToday = measurements.filter(
            (m) => !String(m.id).startsWith(`${newDateKey}_`)
        );

        return [...withoutToday, mergedReading].sort((a, b) =>
            String(a.id).localeCompare(String(b.id))
        );
    };

    const sendReadings = async () => {
        setConfirmMissing({ open: false, missingTanks: [] });
        setConfirmMessurments({ open: false, unvalidMessurments: [] })
        setSendingReading("loading");



        let readingsToSend = brews
            .filter((fv) => Number(fv.tankNumber) !== 1)
            .map((fv) => {
                const reading = newReadings[fv.id] ?? {};
                return {
                    id: buildMeasurementId(),
                    tankId: fv.id,
                    tankNumber: fv.tankNumber,
                    ...reading,
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
                                ? `\nסה"כ ${totalLiters.toFixed(2)} ליטר, פחת ${shrinkagePercent.toFixed(2)}%`
                                : `סה"כ ${totalLiters.toFixed(2)} ליטר`;

                        const existingNotes =
                            (r as any).notes as string | undefined;

                        r = {
                            ...r,
                            notes: existingNotes
                                ? `${existingNotes} | ${shrinkageText}`
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
        }
        try {
            const res = await writeReadingsToSheets(readingsToSend);
            setSendResults(res);

            if (reportName === "פעולות") {
                const dryHopEntries = readingsToSend.filter(
                    (r) => (r as any).dryHopGrams && (r as any).dryHopType
                );

                if (dryHopEntries.length > 0) {
                    await Promise.all(
                        dryHopEntries.map(async (r) => {
                            if (!r.sheetUrl) return;
                            try {
                                await assignDryHopToHopsTable(
                                    String(r.sheetUrl),
                                    Number((r as any).dryHopGrams),
                                    String((r as any).dryHopType)
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

            const succeededReadings = readingsToSend.filter((r) => {
                const result = res.find((rr) => String(rr.tankId) === String(r.tankId));
                return result?.success !== false;
            });

            pushCurrentDataToFirestore(succeededReadings).catch((error) => {
                console.error("Failed to push current data to Firestore:", error);
            });
            setNewReadings({});
            // if (reportName !== "פעולות") {
            //     triggerTankUpdate().catch((error) => {
            //         console.error("Background tank update failed:", error);
            //     });
            // } else {
            //     readingsToSend
            //         .filter((r) => (r as any).refreshTank === true)
            //         .forEach((r) => {
            //             if (!r.sheetUrl) return;
            //             refreshSingleTank(String(r.tankId), String(r.sheetUrl)).catch((error) => {
            //                 console.error("Failed to refresh tank", r.tankId, error);
            //             });
            //         });
            // }
            if (!specs) {
                console.warn("Specs are not loaded yet");
                return;
            }
            try {
                if (reportName === "חם" || reportName === "לחץ") {
                    let fullTanks = brews.filter((fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1);
                    if (reportName === "חם") {
                        fullTanks = fullTanks.filter((fv) => fv.stage?.name === "חם" || Number(fv.currentData?.temp) > 9)
                    }
                    setSendingReading("getRecs")
                    const getRecs = async () => {
                        const entries = await Promise.all(
                            fullTanks.map(async (tank: Fermentor) => {
                                const messurments = measurementsCache.current[String(tank.tankNumber)]
                                    ?? await getMeasurementsByBatch(tank.batchNumber ?? "")
                                if (!tank.stage || !tank.brewDate) {
                                    console.warn(
                                        "Cannot calculate recommendations: stage or brew date is missing",
                                        tank.id,
                                        tank.tankNumber
                                    );

                                    return [tank.tankNumber, null] as const;
                                }
                                const newReadingForTank = readingsToSend.find(
                                    (r) => Number(r.tankNumber) === Number(tank.tankNumber)
                                );

                                const messurmentsWithToday = newReadingForTank
                                    ? mergeReadingIntoMeasurements(messurments, newReadingForTank)
                                    : messurments;
                                const rec = await calcCelleringRecomendations(
                                    messurmentsWithToday,
                                    tank.beerStyle,
                                    tank.batchNumber ?? "",
                                    tank.brewDate ?? "",
                                    specs,
                                    tank.stage!
                                ).catch((err) => {
                                    console.error("Failed for tank", tank.id, tank.tankNumber, err);
                                    return null;
                                });
                                return [tank.tankNumber, rec] as const;
                            })
                        );

                        const recomendations: Record<string, Awaited<ReturnType<typeof calcCelleringRecomendations>>> =
                            Object.fromEntries(entries);

                        return recomendations;
                    };
                    const recommendations = await getRecs();

                    setRcs(recommendations);
                    setSendingReading(res.every((r) => r.success) ? "sent" : "error");
                }
                else {
                    setSendingReading(res.every((r) => r.success) ? "idle" : "error");
                }
            } catch (error) {
                console.error("Failed to update database:", error);
            }
        } catch (error) {
            setSendResults([]);
            setSendingReading("error");
        }
    };

    const closeStatusModal = () => {
        setSendingReading("idle");
        setSendResults([]);
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
        let fullTanks = brews.filter((fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1);
        if (reportName === "חם") fullTanks = fullTanks.filter((fv) => fv.stage?.name === "חם" || Number(fv.currentData?.temp) > 9);

        const byTank = await fetchAllTankMeasurements(fullTanks);
        const readingsToCheck = brews
            .filter((fv) => (Number(fv.tankNumber) !== 1) && Number(fv.action) === 1)
            .map((fv) => {
                if (!fv.tankNumber) { return null }
                const reading = newReadings[fv.id] ?? {};
                const current = fv.currentData;
                const previus = byTank[fv.tankNumber]
                return { tankNumber: fv.tankNumber, new: reading, current, previus }
            }).filter(
                (r): r is NonNullable<typeof r> => r !== null
            );
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
                sortedMeasurements[sortedMeasurements.length - 2];
            const currentTemp = Number(readingSet.current?.temp);
            const newTemp = Number(readingSet.new.temp);
            const currentPressure = Number(readingSet.current?.pressure);
            const newPressure = Number(readingSet.new.pressure);
            const currentPh = Number(readingSet.current?.pH);
            const newPh = Number(readingSet.new.pH);
            const currentPlato = Number(readingSet.current?.plato);
            const newPlato = Number(readingSet.new.plato);



            if (currentTemp - newTemp > 5 || newTemp - currentTemp > 5) {
                if (currentTemp - newTemp > 5) {
                    const cooled = yesterdayMeasurement?.notes?.toString().includes("קירור") ||
                        yesterdayMeasurement?.notes?.toString().includes("קירור");
                    if (!cooled) invalidText.push(`במיכל ${readingSet.tankNumber} נמצא הפרש של ${newTemp - currentTemp} מעלות ממדידה קודמת. האם הזנת נתון תקין?`)

                }
            }
            const pDelata = currentPressure - newPressure;
            if (pDelata < -0.5) {
                if (!(yesterdayMeasurement?.notes?.toString().includes("סגירת")
                    || yesterdayMeasurement?.notes?.toString().includes("סגירה")
                    || yesterdayMeasurement?.notes?.toString().includes("העלאת")
                    || yesterdayMeasurement?.notes?.toString().includes("להעלות לחץ")
                )) {
                    invalidText.push(`במיכל ${readingSet.tankNumber} נמצאה עלייה בלחץ של יותר מ0.5bar למרות שלא נסגר המיכל ולא נמצאה העלאת לחץ. האם הזנת נתון תקין?`)
                }
            }
            if (pDelata > 0.5) {
                if (!(yesterdayMeasurement?.notes?.toString().includes("הורדת")
                    || yesterdayMeasurement?.notes?.toString().includes("להוריד לחץ")
                )) {
                    invalidText.push(`במיכל ${readingSet.tankNumber} נמצאה ירידה בלחץ של יותר מ0.5bar למרות שלא נמצאה הורדת לחץ או הורדת שמרים. האם הזנת נתון תקין?`)
                }
            }
            if (newPressure && !newTemp) {
                invalidText.push(`במיכל ${readingSet.tankNumber} דווח לחץ אך לא דווח טמפ'. לתשומת ליבך`)
            }
            if (newTemp && !newPressure) {
                if (newPressure !== 0) {
                    invalidText.push(`במיכל ${readingSet.tankNumber} דווח טמפ אך לא דווח . לתשומת ליבך`)
                }
            }
            if (newPh > 6) {
                invalidText.push(`במיכל ${readingSet.tankNumber} נמצא pH מעל 6. האם הזנת נתון תקין?`)
            }
            if (newPh < 3.5) {
                invalidText.push(`במיכל ${readingSet.tankNumber} נמצא pH מתחת 3.5. האם הזנת נתון תקין?`)
            }
            if (newPh - currentPh > 0.3 || currentPh - newPh > 0.3) {
                invalidText.push(`במיכל ${readingSet.tankNumber} דווח pH בהפרש של יותר מ0.3 ממדידה קודמת. האם הזנת נתון תקין?`)
            }
            if (newPlato - currentPlato > 0.3) {
                invalidText.push(`במיכל ${readingSet.tankNumber} דווח היום Plato גבוה יותר ממדידה קודמת ב0.3. לתשומת ליבך`)
            }
            if (newPlato && !newPh) {
                invalidText.push(`במיכל ${readingSet.tankNumber} דווח Plato אך לא דווח pH. לתשומת ליבך`)
            }
            if (newPh && !newPlato) {
                invalidText.push(`במיכל ${readingSet.tankNumber} דווח pH אך לא דווח Plato. לתשומת ליבך`)
            }

        })
        if (invalidText.length > 0) {
            setConfirmMessurments({ open: true, unvalidMessurments: invalidText })
        } else {
            void sendReadings()
        }
        setSendingReading("getRecs")
    };

    let canSend = brews.filter((fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1 && (reportName === "לחץ" ? true : Number(fv.currentData?.temp) > 9)).length === getMissingTanks()?.length;
    if (reportName === "פעולות") {
        canSend = Object.keys(newReadings).length < 1 || !!hasIncompleteNotes;
    }

    const getActiveRecommendations = (
        tankNumber: string | number
    ): Recommendation[] => {

        const rec = rcs[String(tankNumber)];

        if (!rec) {
            return [];
        }

        return [
            rec.lastMessurmentUpToDate,
            rec.requiresDryHop,
            rec.requiresPresureClose,
            rec.requiresWarmYeastDrop,
            rec.requiersYeastDropAfterCooling,
            rec.requiresCarbTest,
            rec.requiersDiacytelRest,
            rec.neglectedStatus,
            rec.requiresToCoolDown,
            rec.requiredPressureAdjustment,
        ]
            .filter(Boolean)
            .map((recommendation) => ({
                req: Boolean(recommendation.req),
                reason: recommendation.reason,
                importance: recommendation.importance,
                display:
                    "display" in recommendation
                        ? Boolean(recommendation.display)
                        : false,
            }))
            .filter((recommendation) => recommendation.req)
            .filter((recommendation) => recommendation.display)
            .sort(
                (a, b) =>
                    b.importance - a.importance
            );
    };

    function getDailyActionRecommendation() {
        for (const recommendation of Object.values(rcs)) {
            if (recommendation?.requiresDailyActions?.req) {
                if (recommendation?.requiresDailyActions.reason ===
                    "מומלץ ביום ראשון לבצע הורדת שמרים ובדיקת גיזוז לכל מיכל קר") {
                    recommendation.requiresDailyActions.reason = "מומלץ ביום ראשון לבצע הורדת שמרים ובדיקת גיזוז לכל המיכלים הקרים"

                } else if (recommendation?.requiresDailyActions.reason ===
                    "מומלץ ביום רביעי לבצע בדיקת גיזוז לכל מיכל שיורד שבוע הבא. בדוק אם המיכל מתוכנן לרדת") {
                    recommendation.requiresDailyActions.reason = "מומלץ ביום רביעי לבצע בדיקת גיזוז לכל המיכלים שיורד שבוע הבא. בדוק איזה מיכלים מתוכננים לרדת"

                } else if (recommendation?.requiresDailyActions.reason ===
                    "מומלץ ביום חמישי לבצע הורדת שמרים לכל מיכל שיורד שבוע הבא. בדוק אם המיכל מתוכנן לרדת")
                    recommendation.requiresDailyActions.reason =
                        "מומלץ ביום חמישי לבצע הורדת שמרים לכל המיכלים שיורדים שבוע הבא. בדוק איזה מיכלים מתוכננים לרדת";
                return recommendation.requiresDailyActions;
            }
        }

        return null;
    };

    const dailyActionRecommendation = getDailyActionRecommendation();


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

                        {sendingReading === "loading" && <p className="status-loading">שולח נתונים...</p>}
                        {sendingReading === "sync" && <p className="status-loading">מרענן נתוני שרת...</p>}
                        {sendingReading === "getRecs" && <p className="status-loading">טוען המלצות סלרינג...</p>}
                        {sendingReading === "checking" && <p className="status-loading">בודק תקינות נתונים...</p>}
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
                                        {Object.keys(sendResults).length > 0 && <p>
                                            הנתונים נשלחו בהצלחה
                                        </p>}

                                        <p>מצורפות המלצות לסלרינג!</p>
                                        <p>יש להסתכל בדף בישול של כל מיכל ולוודא את ההמלצה!</p>

                                    </div>

                                    {dailyActionRecommendation?.req && (
                                        <div className="daily-recommendation">
                                            <div className="daily-recommendation-title">
                                                🔔 פעולה יומית
                                            </div>

                                            <div className="daily-recommendation-reason">
                                                {dailyActionRecommendation.reason}
                                            </div>
                                        </div>
                                    )}


                                    <div className="tank-recommendations-list">

                                        {brews
                                            .filter(
                                                (tank) =>
                                                    Number(tank.tankNumber) !== 1 &&
                                                    Number(tank.action) === 1
                                            )
                                            .map((tank) => {
                                                const recommendations =
                                                    getActiveRecommendations(tank.tankNumber ?? "");

                                                if (recommendations.length)
                                                    return (
                                                        <div
                                                            key={tank.id}
                                                            className={`tank-recommendation-card recommendation-${tank.stage?.className}`}
                                                        >

                                                            <div className="tank-recommendation-header recomendations_cell">

                                                                <p>
                                                                    מיכל {tank.tankNumber}- {tank.beerStyle}
                                                                </p>

                                                                <span
                                                                    className={
                                                                        `rec-label-${tank.stage?.name === "בתסיסה" ? "fermenting" : "cold"}`
                                                                    }
                                                                >
                                                                    {tank.stage?.icon} {tank.stage?.name}
                                                                </span>

                                                            </div>


                                                            <div className="tank-recommendations">

                                                                {recommendations.map(
                                                                    (recommendation, index) => (
                                                                        <div
                                                                            key={index}
                                                                            className={`recommendation-cell level-${recommendation.importance}`}
                                                                        >
                                                                            {recommendation.reason}
                                                                        </div>
                                                                    )
                                                                )}

                                                            </div>
                                                        </div>
                                                    );
                                            })}

                                    </div>

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
        </>
    )
}