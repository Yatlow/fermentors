import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import {
    calcCelleringRecomendations,
    type Measurement,
} from "../../SERVICES/cellering/calculateCelleringRecomendations";
import { STAGE_INFO } from "../../SERVICES/dashboard/tankstage";
import {
    buildPressureV4DecisionState,
} from "../../SERVICES/cellering/pressurePredictionV4";
import {
    estimatePressureTargetV6,
    selectV6HistoricalBatchIds,
    type PressureV6Estimate,
} from "../../SERVICES/cellering/pressurePredictionV6";
import {
    estimatePressureTargetV7,
    type PressureV7Estimate,
} from "../../SERVICES/cellering/pressurePredictionV7";
import {
    getColdReferenceTemperatureV4,
    getEquilibriumPressureForV4,
    getPressurePredictionModelV4,
    type PressurePredictionModelV4,
} from "../../SERVICES/cellering/pressurePredictionV4Model";
import {
    runPressureV6LeaveOneBatchOutBacktest,
    type PressureV6BacktestResult,
} from "../../SERVICES/cellering/pressurePredictionV6Backtest";
import {
    runPressureV7LeaveOneBatchOutBacktest,
} from "../../SERVICES/cellering/pressurePredictionV7Backtest";
import "./CellarSimulator.css";

type Treatment = "none" | "ordinaryPressure" | "bottomCarbonation";
type StageMode = "actual" | "cold" | "warm";
type CarbonationScenarioMode = "auto" | "first" | "subsequent";
type EvaluationTimeMode = "now" | "atMeasurement";

type Props = {
    brews: Fermentor[];
    specs: SpecChart | null;
};

type RecommendationLike = {
    req?: boolean;
    display?: boolean;
    reason?: string;
    importance?: number;
};

const RECOMMENDATION_LABELS: Record<string, string> = {
    lastMessurmentUpToDate: "עדכניות מדידות",
    requiresDryHop: "דרייהופ",
    requiresPresureClose: "סגירת לחץ",
    requiresWarmYeastDrop: "הורדת שמרים חמה",
    requiresWarmYeastDropCompletion: "השלמת הורדת שמרים חמה",
    requiersYeastDropAfterCooling: "הורדת שמרים אחרי קירור",
    requiresColdYeastDropCompletion: "השלמת הורדת שמרים קרה",
    requiiersWedYeastDropOnThus: "הורדת שמרים שבועית",
    requiresCarbTest: "בדיקת גיזוז",
    requiredBottomCarbonation: "גיזוז מלמטה",
    requiersDiacytelRest: "מנוחת דיאצטיל",
    neglectedStatus: "מיכל מוזנח",
    requiresToCoolDown: "קירור",
    requiredPressureAdjustment: "שינוי לחץ",
};

function dateKey(daysAgo = 0): string {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

function rowDate(row: Measurement): string | null {
    const match = String(row.id ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] ?? null;
}

function removeBottomCarbonationNotes(note: unknown): string | undefined {
    const parts = String(note ?? "")
        .split(/\s*\|\s*/)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !part.includes("גיזוז מלמטה"));
    return parts.length ? parts.join(" | ") : undefined;
}

function isCoolingStartNote(note: unknown): boolean {
    const text = String(note ?? "");
    if (!text.includes("קירור")) return false;
    if (/אחרי\s+קירור|לאחר\s+קירור/.test(text)) return false;
    return /(?:^|\||\s)קירור(?:$|\||\s|[-–—])/u.test(text);
}

function priorCarbonationChecksAfterCooling(
    source: Measurement[],
    carbDate: string,
): number {
    const previous = source
        .filter((row) => {
            const date = rowDate(row);
            return !date || date < carbDate;
        })
        .slice()
        .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));

    const coolingIndex = previous.findLastIndex((row) =>
        isCoolingStartNote(row.notes)
    );
    const relevant = coolingIndex >= 0
        ? previous.slice(coolingIndex + 1)
        : previous;

    return relevant.filter((row) =>
        row.carbonation !== null &&
        row.carbonation !== undefined &&
        row.carbonation !== "" &&
        Number.isFinite(Number(row.carbonation))
    ).length;
}

function resolveFirstCarbonation(args: {
    source: Measurement[];
    carbAgeDays: number;
    mode: CarbonationScenarioMode;
}): {
    first: boolean;
    priorChecks: number;
} {
    const carbDate = dateKey(args.carbAgeDays);
    const priorChecks = priorCarbonationChecksAfterCooling(
        args.source,
        carbDate,
    );

    if (args.mode === "first") return { first: true, priorChecks };
    if (args.mode === "subsequent") return { first: false, priorChecks };
    return { first: priorChecks === 0, priorChecks };
}

function carbonationMeasurementDayText(daysAgo: number): string {
    if (daysAgo <= 0) return "היום";
    if (daysAgo === 1) return "אתמול";
    if (daysAgo === 2) return "לפני יומיים";
    return `לפני ${daysAgo} ימים`;
}

function buildHypotheticalProductionPressureTextV6(
    estimate: PressureV6Estimate,
    carbAgeDays: number,
): string {
    const measured = estimate.measuredCarbonation;
    const target = estimate.targetCarbonation;
    const measurementDay = carbonationMeasurementDayText(carbAgeDays);
    const relation =
        measured < target ? "נמוך" : measured > target ? "גבוה" : "תקין";

    const intro =
        `הגיזוז בבדיקה שנלקחה ${measurementDay} ${relation} ` +
        `(${measured.toFixed(2)}, גיזוז תקין ${target.toFixed(2)}). `;

    if (estimate.edgeCase === "head_pressure_insufficient") {
        return (
            intro +
            "גם בלחץ הראש המקסימלי המותר לא ניתן להכניס את המיכל למסלול הסופי הרצוי. מומלץ לעבור למסלול גיזוז מלמטה ולבצע בדיקת גיזוז חוזרת לאחר הטיפול."
        );
    }

    if (estimate.edgeCase === "venting_below_zero") {
        return (
            intro +
            "המסלול הסופי דורש פריקה מעבר ללחץ אטמוספרי. מומלץ לבצע פריקה מבוקרת ולבדוק גיזוז מחדש."
        );
    }

    if (estimate.targetPressure === null) {
        return intro + "אין כרגע יעד לחץ אוטומטי אמין. מומלץ לבצע בדיקת גיזוז חוזרת.";
    }

    if (estimate.action === "hold") {
        return (
            intro +
            `המסלול הקינטי הנוכחי צפוי להתכנס ל-${estimate.terminalCarbonationAtTarget?.toFixed(2) ?? target.toFixed(2)} vol ` +
            `בלחץ סופי של כ-${estimate.terminalPressureAtTarget?.toFixed(2) ?? estimate.currentPressure.toFixed(2)} bar. ` +
            `מומלץ להשאיר את הלחץ על ${estimate.currentPressure.toFixed(2)} bar ולבצע בדיקת גיזוז חוזרת בעוד יומיים.`
        );
    }

    if (estimate.action === "raise") {
        return (
            intro +
            `מומלץ להעלות את הלחץ ל-${estimate.targetPressure.toFixed(2)} bar כדי להכניס את המיכל למסלול המתכנס ליעד, ` +
            "ולבצע בדיקת גיזוז חוזרת בעוד יומיים."
        );
    }

    return (
        intro +
        `מומלץ להוריד את הלחץ ל-${estimate.targetPressure.toFixed(2)} bar כדי להכניס את המיכל למסלול המתכנס ליעד, ` +
        "ולבצע בדיקת גיזוז חוזרת בעוד יומיים."
    );
}

function historicalBatchIdsFromModel(
    model: PressurePredictionModelV4,
): string[] {
    const ids = new Set<string>();
    const add = (value: unknown) => {
        const id = String(value ?? "").replace("#", "").trim();
        if (id) ids.add(id);
    };

    model.samples.forEach((sample) => add(sample.batchId));
    model.passiveSamples.forEach((sample) => add(sample.batchId));
    model.transitions.forEach((sample) => add(sample.batchId));
    model.equilibriumPoints.forEach((point) => add(point.batchId));

    return Array.from(ids);
}

function percent(value: number | null): string {
    return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function backtestReadinessText(
    readiness: PressureV6BacktestResult["readiness"],
): string {
    if (readiness === "passes_gate") {
        return "עובר את סף האמון שהגדרנו לפרודקשן";
    }
    if (readiness === "promising") {
        return "מבטיח, אבל עדיין לא מספיק חזק לפרודקשן";
    }
    if (readiness === "insufficient_data") {
        return "אין עדיין מספיק אצוות כדי להסיק";
    }
    return "לא מספיק מדויק כרגע";
}

function numericOrUndefined(value: string): number | undefined {
    if (value.trim() === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function scenarioMeasurements(args: {
    source: Measurement[];
    carbAgeDays: number;
    carbonation: number;
    pressure?: number;
    temp?: number;
    plato?: number;
    firstCarbonation: boolean;
    treatment: Treatment;
    evaluationTimeMode: EvaluationTimeMode;
}): Measurement[] {
    const carbDate = dateKey(args.carbAgeDays);
    const today = dateKey(0);

    let base = args.source
        .filter((row) => {
            const date = rowDate(row);
            return !date || date < carbDate;
        })
        .map((row) => ({ ...row }));

    if (args.firstCarbonation) {
        base = base.map((row) => ({
            ...row,
            carbonation: undefined,
            notes: removeBottomCarbonationNotes(row.notes),
        }));
    }

    let treatmentNote: string | undefined;
    if (args.treatment === "ordinaryPressure") {
        const target = args.pressure ?? 1.2;
        treatmentNote = `העלאת לחץ ל${target} bar`;
    } else if (args.treatment === "bottomCarbonation") {
        const closePressure = args.pressure ?? 0.8;
        treatmentNote =
            `הורדת לחץ ל0.2 bar. תחילת גיזוז מלמטה בשעה 10:00 | ` +
            `סגירת גיזוז מלמטה בשעה 10:45 על ${closePressure} bar.`;
    }

    const carbRow: Measurement = {
        id: `${carbDate}_2358`,
        carbonation: args.carbonation,
        pressure: args.pressure,
        temp: args.temp,
        plato: args.plato,
        notes: treatmentNote,
    };

    // Historical replay: stop the timeline at the carbonation measurement.
    // This answers "what would the engine have recommended then?" instead of
    // projecting that old measurement forward to today.
    if (
        args.evaluationTimeMode === "atMeasurement" ||
        args.carbAgeDays === 0
    ) {
        return [...base, carbRow];
    }

    const currentRow: Measurement = {
        id: `${today}_2359`,
        pressure: args.pressure,
        temp: args.temp,
        plato: args.plato,
    };

    return [...base, carbRow, currentRow];
}

export default function CellarSimulator({ brews, specs }: Props) {
    const tanks = useMemo(
        () => brews
            .filter((tank) => Number(tank.tankNumber) > 1 && tank.batchNumber)
            .slice()
            .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews],
    );

    const [tankId, setTankId] = useState("");
    const [source, setSource] = useState<Measurement[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<Record<string, RecommendationLike> | null>(null);
    const [v6Result, setV6Result] = useState<PressureV6Estimate | null>(null);
    const [v6Status, setV6Status] = useState("");
    const [v7Result, setV7Result] = useState<PressureV7Estimate | null>(null);
    const [v7Status, setV7Status] = useState("");
    const [backtestRunning, setBacktestRunning] = useState(false);
    const [backtestProgress, setBacktestProgress] = useState("");
    const [backtestResult, setBacktestResult] =
        useState<PressureV6BacktestResult | null>(null);
    const [backtestV6Result, setBacktestV6Result] =
        useState<PressureV6BacktestResult | null>(null);

    const [carbonation, setCarbonation] = useState("2.10");
    const [pressure, setPressure] = useState("");
    const [temp, setTemp] = useState("");
    const [plato, setPlato] = useState("");
    const [carbAgeDays, setCarbAgeDays] = useState(0);
    const [treatment, setTreatment] = useState<Treatment>("none");
    const [carbonationScenarioMode, setCarbonationScenarioMode] =
        useState<CarbonationScenarioMode>("auto");
    const [stageMode, setStageMode] = useState<StageMode>("actual");
    const [evaluationTimeMode, setEvaluationTimeMode] =
        useState<EvaluationTimeMode>("now");

    const tank = tanks.find((item) => item.id === tankId) ?? null;

    useEffect(() => {
        setResult(null);
        setV6Result(null);
        setV6Status("");
        setV7Result(null);
        setV7Status("");
        setV7Result(null);
        setV7Status("");
        setBacktestResult(null);
        setBacktestV6Result(null);
        setBacktestProgress("");
        setError("");
        if (!tank?.batchNumber) {
            setSource([]);
            return;
        }

        setPressure(
            tank.currentData?.pressure !== null && tank.currentData?.pressure !== undefined
                ? String(tank.currentData.pressure)
                : "",
        );
        setTemp(
            tank.currentData?.temp !== null && tank.currentData?.temp !== undefined
                ? String(tank.currentData.temp)
                : "",
        );
        setPlato(
            tank.currentData?.plato !== null && tank.currentData?.plato !== undefined
                ? String(tank.currentData.plato)
                : "",
        );

        let active = true;
        setLoadingHistory(true);
        void getMeasurementsByBatch(tank.batchNumber)
            .then((rows) => {
                if (active) setSource(rows);
            })
            .catch((reason) => {
                if (active) setError(reason instanceof Error ? reason.message : String(reason));
            })
            .finally(() => {
                if (active) setLoadingHistory(false);
            });

        return () => {
            active = false;
        };
    }, [tank?.id, tank?.batchNumber]);

    const activeRecommendations = useMemo(() => {
        if (!result) return [];
        return Object.entries(result)
            .filter(([key, value]) =>
                key !== "requiresDailyActions" &&
                value &&
                typeof value === "object" &&
                value.req === true &&
                value.display !== false
            )
            .map(([key, value]) => ({
                key,
                label: RECOMMENDATION_LABELS[key] ?? key,
                reason: String(value.reason ?? ""),
                importance: Number(value.importance ?? 1),
            }))
            .sort((a, b) => b.importance - a.importance);
    }, [result]);

    async function runBacktest() {
        if (!tank?.beerStyle || !specs) return;

        setBacktestRunning(true);
        setBacktestResult(null);
        setBacktestV6Result(null);
        setBacktestProgress("טוען מודל היסטורי…");
        setError("");

        try {
            const normalizedStyle = String(tank.beerStyle ?? "")
                .trim()
                .toLowerCase()
                .split(/\s+/)[0] || "other";
            const targetCarbonation =
                specs.carbonation?.[normalizedStyle] ??
                specs.carbonation?.other;
            if (!Number.isFinite(Number(targetCarbonation))) {
                throw new Error("אין יעד גיזוז זמין לסגנון");
            }

            const model = await getPressurePredictionModelV4(tank.beerStyle);
            if (!model) {
                throw new Error("אין מודל היסטורי זמין לסגנון");
            }

            const allBatchIds = historicalBatchIdsFromModel(model);
            const maxHistoricalBatches = 80;
            const batchIds = allBatchIds.slice(0, maxHistoricalBatches);
            const historicalBatches: {
                batchId: string;
                measurements: Measurement[];
            }[] = [];
            const chunkSize = 8;

            for (
                let startIndex = 0;
                startIndex < batchIds.length;
                startIndex += chunkSize
            ) {
                const chunk = batchIds.slice(
                    startIndex,
                    startIndex + chunkSize,
                );
                setBacktestProgress(
                    `טוען היסטוריה: ${Math.min(startIndex + chunk.length, batchIds.length)}/${batchIds.length} אצוות…`
                );

                const loaded = (
                    await Promise.all(
                        chunk.map(async (batchId) => {
                            try {
                                return {
                                    batchId,
                                    measurements:
                                        await getMeasurementsByBatch(batchId),
                                };
                            } catch (historyError) {
                                console.warn(
                                    "V6 backtest batch unavailable",
                                    { batchId, historyError },
                                );
                                return null;
                            }
                        })
                    )
                ).filter((item): item is {
                    batchId: string;
                    measurements: Measurement[];
                } => item !== null);

                historicalBatches.push(...loaded);
            }

            setBacktestProgress("מריץ Leave-One-Batch-Out ל-V6 ול-V7…");
            const backtestArgs = {
                model,
                historicalBatches,
                targetCarbonation: Number(targetCarbonation),
                targetToleranceVol:
                    specs.tolorances?.carbonation ?? 0.04,
                maxCases: 120,
            };
            const v6Backtest =
                runPressureV6LeaveOneBatchOutBacktest(backtestArgs);
            const v7Backtest =
                runPressureV7LeaveOneBatchOutBacktest(backtestArgs);

            setBacktestV6Result(v6Backtest);
            setBacktestResult(v7Backtest);
            setBacktestProgress(
                allBatchIds.length > maxHistoricalBatches
                    ? `נבדקו עד ${maxHistoricalBatches} אצוות מתוך ${allBatchIds.length} הזמינות במודל.`
                    : ""
            );
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : String(reason)
            );
            setBacktestProgress("");
        } finally {
            setBacktestRunning(false);
        }
    }

    async function runSimulation() {
        if (!tank || !tank.batchNumber || !tank.beerStyle || !tank.brewDate || !specs) return;

        const carbonationValue = Number(carbonation);
        if (!Number.isFinite(carbonationValue)) {
            setError("יש להזין ערך גיזוז תקין");
            return;
        }

        setRunning(true);
        setError("");
        setResult(null);
        setV6Result(null);
        setV6Status("");

        try {
            const carbonationScenario = resolveFirstCarbonation({
                source,
                carbAgeDays,
                mode: carbonationScenarioMode,
            });

            const simulated = scenarioMeasurements({
                source,
                carbAgeDays,
                carbonation: carbonationValue,
                pressure: numericOrUndefined(pressure),
                temp: numericOrUndefined(temp),
                plato: numericOrUndefined(plato),
                firstCarbonation: carbonationScenario.first,
                treatment,
                evaluationTimeMode,
            });

            const stage =
                stageMode === "cold"
                    ? STAGE_INFO[2]
                    : stageMode === "warm"
                        ? STAGE_INFO[1]
                        : tank.stage ?? STAGE_INFO[2];

            const recommendations = await calcCelleringRecomendations(
                simulated,
                tank.beerStyle,
                tank.brewDate,
                specs,
                stage,
                Number(tank.tankNumber),
                true,
                brews,
            );

            setResult((recommendations ?? {}) as Record<string, RecommendationLike>);

            const normalizedStyle = String(tank.beerStyle ?? "")
                .trim()
                .toLowerCase()
                .split(/\s+/)[0] || "other";
            const carbonationTarget =
                specs.carbonation?.[normalizedStyle] ??
                specs.carbonation?.other;

            if (!Number.isFinite(Number(carbonationTarget))) {
                setV6Status("אין יעד גיזוז זמין לסגנון");
            } else {
                const v4Model = await getPressurePredictionModelV4(tank.beerStyle);
                const equilibriumForTemp = v4Model
                    ? (temperature: number | null) =>
                        getEquilibriumPressureForV4(v4Model, temperature)
                    : undefined;

                const state = buildPressureV4DecisionState({
                    measurements: simulated,
                    equilibriumPressure: equilibriumForTemp,
                });

                if (!state) {
                    setV6Status("אין מספיק נתוני מצב נוכחי לחישוב V6");
                } else if (
                    state.currentTemp !== null &&
                    state.currentTemp > 9
                ) {
                    setV6Status(
                        "המיכל עדיין חם מדי לחישוב לחץ גיזוז קר"
                    );
                } else {
                    const coldReferenceTemperature = v4Model
                        ? getColdReferenceTemperatureV4(v4Model)
                        : null;

                    const currentBatchId =
                        String(tank.batchNumber).replace("#", "");
                    const historicalBatchIds = v4Model
                        ? selectV6HistoricalBatchIds({
                            samples: v4Model.samples,
                            passiveSamples: v4Model.passiveSamples,
                            state,
                            currentBatchId,
                            limit: 32,
                        })
                        : [];

                    const targetToleranceVol =
                        specs.tolorances?.carbonation ?? 0.04;
                    const historicalBatches = (
                        await Promise.all(
                            historicalBatchIds
                                .slice(0, 32)
                                .map(async (batchId) => {
                                    try {
                                        return {
                                            batchId,
                                            measurements:
                                                await getMeasurementsByBatch(batchId),
                                        };
                                    } catch (historyError) {
                                        console.warn("Pressure history unavailable", {
                                            batchId,
                                            historyError,
                                        });
                                        return null;
                                    }
                                })
                        )
                    ).filter((item): item is {
                        batchId: string;
                        measurements: Measurement[];
                    } => item !== null);

                    const v7Estimate = estimatePressureTargetV7({
                        state,
                        historicalBatches,
                        targetCarbonation: Number(carbonationTarget),
                        targetToleranceVol,
                        currentBatchId,
                    });
                    if (v7Estimate) {
                        setV7Result(v7Estimate);
                        setV7Status("");
                    } else {
                        setV7Status("לא ניתן לבנות חישוב V7 מהמצב הנוכחי");
                    }

                    const v6Estimate = estimatePressureTargetV6({
                        samples: v4Model?.samples ?? [],
                        passiveSamples: v4Model?.passiveSamples ?? [],
                        transitions: v4Model?.transitions ?? [],
                        state,
                        measurements: simulated,
                        historicalBatches,
                        targetCarbonation: Number(carbonationTarget),
                        targetToleranceVol,
                        coldReferenceTemperature,
                        currentBatchId,
                    });

                    if (v6Estimate) {
                        setV6Result(v6Estimate);
                        setV6Status("");
                    } else {
                        setV6Status("לא ניתן לבנות חישוב V6 מהמצב הנוכחי");
                    }
                }
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setRunning(false);
        }
    }

    return (
        <section className="cellar-simulator" dir="rtl">
            <div className="cellar-simulator-header">
                <div>
                    <h2>סימולטור סלרינג</h2>
                    <p>כלי Preview/פיתוח של V7 מול V6. V7 בוחר לחץ לפי תוצאות היסטוריות של מצבים דומים; אין כתיבה ל-Firestore או ל-Sheets.</p>
                </div>
                <span className="cellar-simulator-badge">READ ONLY</span>
            </div>

            <div className="cellar-simulator-grid">
                <label>
                    <span>מיכל</span>
                    <select value={tankId} onChange={(event) => setTankId(event.target.value)}>
                        <option value="">בחר מיכל</option>
                        {tanks.map((item) => (
                            <option key={item.id} value={item.id}>
                                מיכל {item.tankNumber} · #{String(item.batchNumber).replace("#", "")} · {item.beerStyle}
                            </option>
                        ))}
                    </select>
                </label>

                <label>
                    <span>שלב לבדיקה</span>
                    <select value={stageMode} onChange={(event) => setStageMode(event.target.value as StageMode)}>
                        <option value="actual">השלב האמיתי של המיכל</option>
                        <option value="cold">כאילו המיכל קר</option>
                        <option value="warm">כאילו המיכל בתסיסה</option>
                    </select>
                </label>

                <label>
                    <span>גיזוז מדומה</span>
                    <input type="number" step="0.01" value={carbonation} onChange={(event) => setCarbonation(event.target.value)} />
                </label>

                <label>
                    <span>מתי נמדד הגיזוז</span>
                    <select value={carbAgeDays} onChange={(event) => setCarbAgeDays(Number(event.target.value))}>
                        <option value={0}>היום</option>
                        <option value={1}>אתמול</option>
                        <option value={2}>לפני יומיים</option>
                        <option value={3}>לפני 3 ימים</option>
                    </select>
                </label>

                <label>
                    <span>מתי לחשב את ההמלצה</span>
                    <select
                        value={evaluationTimeMode}
                        onChange={(event) =>
                            setEvaluationTimeMode(
                                event.target.value as EvaluationTimeMode
                            )
                        }
                    >
                        <option value="now">
                            עכשיו — לקדם מדידה ישנה עד היום
                        </option>
                        <option value="atMeasurement">
                            בזמן המדידה — מה היה מומלץ אז
                        </option>
                    </select>
                </label>

                <label>
                    <span>לחץ</span>
                    <input type="number" step="0.01" value={pressure} onChange={(event) => setPressure(event.target.value)} placeholder="bar" />
                </label>

                <label>
                    <span>טמפרטורה</span>
                    <input type="number" step="0.1" value={temp} onChange={(event) => setTemp(event.target.value)} placeholder="°C" />
                </label>

                <label>
                    <span>Plato</span>
                    <input type="number" step="0.1" value={plato} onChange={(event) => setPlato(event.target.value)} />
                </label>

                <label>
                    <span>טיפול אחרי בדיקת הגיזוז</span>
                    <select value={treatment} onChange={(event) => setTreatment(event.target.value as Treatment)}>
                        <option value="none">ללא טיפול</option>
                        <option value="ordinaryPressure">שינוי לחץ רגיל</option>
                        <option value="bottomCarbonation">גיזוז מלמטה שהושלם</option>
                    </select>
                </label>
            </div>

            <label className="cellar-simulator-check">
                <span>סוג בדיקת הגיזוז</span>
                <select
                    value={carbonationScenarioMode}
                    onChange={(event) =>
                        setCarbonationScenarioMode(
                            event.target.value as CarbonationScenarioMode
                        )
                    }
                >
                    <option value="auto">אוטומטי לפי ההיסטוריה</option>
                    <option value="first">לכפות בדיקה ראשונה אחרי קירור</option>
                    <option value="subsequent">לכפות בדיקה חוזרת</option>
                </select>
            </label>

            <div className="cellar-simulator-v4-status">
                {evaluationTimeMode === "atMeasurement" && carbAgeDays > 0
                    ? `Replay היסטורי: המנוע נעצר בזמן בדיקת הגיזוז מלפני ${carbAgeDays === 1 ? "יום" : `${carbAgeDays} ימים`} ולא רואה שום נתון מאוחר יותר. · `
                    : evaluationTimeMode === "now" && carbAgeDays > 0
                        ? "חישוב להיום: המדידה הישנה מקודמת קדימה לפי הזמן והחשיפה מאז. · "
                        : ""}
                {(() => {
                    const resolved = resolveFirstCarbonation({
                        source,
                        carbAgeDays,
                        mode: carbonationScenarioMode,
                    });
                    return resolved.first
                        ? `זיהוי: בדיקת גיזוז ראשונה אחרי קירור · ${resolved.priorChecks} בדיקות קודמות בהיסטוריה שנכללה`
                        : `זיהוי: בדיקה חוזרת · ${resolved.priorChecks} בדיקות גיזוז קודמות אחרי קירור`;
                })()}
                {" · "}
                ב-V6 אין נוסחה נפרדת לבדיקה ראשונה/חוזרת: אותו optimizer משתמש בכל המידע הזמין. הזיהוי כאן משפיע רק על בניית תרחיש ה-Replay ועל מנוע ההמלצות הישן.
            </div>

            <div className="cellar-simulator-actions">
                <button
                    type="button"
                    className="status-filter-button active"
                    disabled={!tank || !specs || loadingHistory || running}
                    onClick={() => void runSimulation()}
                >
                    {running ? "מחשב…" : "הרץ תרחיש"}
                </button>
                <button
                    type="button"
                    className="status-filter-button"
                    disabled={!tank || !specs || backtestRunning}
                    onClick={() => void runBacktest()}
                >
                    {backtestRunning ? "מריץ Backtest…" : "בדוק דיוק היסטורי"}
                </button>
                {tank && (
                    <span>
                        בסיס: {source.length} מדידות אמיתיות · אין שמירה של התרחיש
                    </span>
                )}
            </div>
            {backtestProgress && (
                <div className="cellar-simulator-v4-status">
                    {backtestProgress}
                </div>
            )}

            {error && <div className="cellar-simulator-error">{error}</div>}

            {backtestResult && (
                <div className="cellar-simulator-results cellar-simulator-backtest">
                    <h3>Backtest — האם ההחלטה של V6 צפויה לעבוד?</h3>
                    <article className="cellar-simulator-result level-1">
                        <strong>
                            {backtestReadinessText(backtestResult.readiness)}
                        </strong>
                        <p>
                            המבחן כבר לא בודק אם V6 ניחש את אותו לחץ שהעובד בחר.
                            בכל נקודת החלטה אצווה אחת מוסתרת לחלוטין, V6 בוחר לחץ,
                            ואז מודל outcome נפרד בודק — מתוך אצוות אחרות בלבד —
                            מה קרה במצבים דומים כשנבחר לחץ דומה: האם הגיעו ליעד
                            בלי תיקון לחץ נוסף או גיזוז מלמטה.
                        </p>

                        <div className="cellar-simulator-backtest-metrics">
                            <div>
                                <b>{percent(backtestResult.estimatedFirstShotSuccessRate)}</b>
                                <span>הצלחה צפויה בפעולה אחת</span>
                            </div>
                            <div>
                                <b>{percent(backtestResult.actualHumanFirstShotSuccessRate)}</b>
                                <span>הצלחה בפועל של החלטות האדם</span>
                            </div>
                            <div>
                                <b>
                                    {backtestResult.estimatedSuccessLiftVsHuman === null
                                        ? "—"
                                        : `${backtestResult.estimatedSuccessLiftVsHuman >= 0 ? "+" : ""}${Math.round(backtestResult.estimatedSuccessLiftVsHuman * 100)}%`}
                                </b>
                                <span>יתרון צפוי מול לחץ האדם</span>
                            </div>
                            <div>
                                <b>
                                    {backtestResult.expectedAbsCarbonationErrorVol === null
                                        ? "—"
                                        : `${backtestResult.expectedAbsCarbonationErrorVol.toFixed(3)} vol`}
                                </b>
                                <span>סטיית גיזוז צפויה מהיעד</span>
                            </div>
                            <div>
                                <b>{percent(backtestResult.dangerousMissRate)}</b>
                                <span>מקרים עם סיכויי הצלחה מתחת ל-50%</span>
                            </div>
                            <div>
                                <b>{percent(backtestResult.counterfactualCoverage)}</b>
                                <span>המלצות עם מספיק מקרים דומים להשוואה</span>
                            </div>
                            <div>
                                <b>{percent(backtestResult.successProbabilityP10)}</b>
                                <span>סיכויי הצלחה בעשירון החלש</span>
                            </div>
                            <div>
                                <b>{percent(backtestResult.modelCoverage)}</b>
                                <span>מקרים שבהם V6 הצליח לתת המלצה</span>
                            </div>
                        </div>

                        <p>
                            בסיס ה-outcome כולל {backtestResult.labeledOutcomeCount} החלטות עם תוצאה ידועה
                            על {backtestResult.labeledOutcomeBatchCount} אצוות:
                            {" "}{backtestResult.successfulOutcomeCount} הגיעו ליעד בלי תיקון נוסף,
                            {" "}{backtestResult.failedOutcomeCount} נזקקו לתיקון / גיזוז מלמטה / חצו את היעד.
                            {" "}ב-Backtest עצמו V6 נתן תשובה ב-{backtestResult.predictedCaseCount}
                            {" "}מתוך {backtestResult.eligibleCaseCount} נקודות החלטה, על
                            {" "}{backtestResult.distinctBatchCount} אצוות שונות.
                        </p>

                        <p className="cellar-simulator-backtest-warning">
                            זה Counterfactual Backtest ולא ניסוי אקראי: כש-V6 בוחר לחץ שלא נוסה
                            באותה אצווה, אנחנו מעריכים את התוצאה מאצוות אחרות עם מצב ולחץ פעולה
                            דומים. לכן כיסוי נמוך אומר שאין לנו מספיק דאטה כדי לשפוט את ההמלצה —
                            לא שהיא טובה או רעה. המדדים מאוזנים לפי אצווה.
                        </p>

                        {backtestResult.imitationPressureMaeBar !== null && (
                            <p className="cellar-simulator-backtest-warning">
                                להשוואה בלבד: V6 שונה מהלחץ שבני אדם בחרו בממוצע ב-
                                {backtestResult.imitationPressureMaeBar.toFixed(2)} bar.
                                המספר הזה אינו חלק מציון האיכות.
                            </p>
                        )}

                        {backtestResult.cases.some(
                            (item) => item.counterfactualSupported
                        ) && (
                            <>
                                <strong>המקרים עם סיכויי ההצלחה הנמוכים ביותר</strong>
                                <div className="cellar-simulator-backtest-cases">
                                    {backtestResult.cases
                                        .filter(
                                            (item) =>
                                                item.counterfactualSupported &&
                                                item.modelEstimatedSuccessProbability !== null
                                        )
                                        .slice()
                                        .sort(
                                            (a, b) =>
                                                (a.modelEstimatedSuccessProbability ?? 1) -
                                                (b.modelEstimatedSuccessProbability ?? 1)
                                        )
                                        .slice(0, 5)
                                        .map((item) => (
                                            <div
                                                key={`${item.batchId}-${item.decisionDateTimeMs}`}
                                            >
                                                <b>#{item.batchId}</b>
                                                <span>
                                                    V6 {item.predictedPressure.toFixed(2)} bar ·
                                                    הצלחה צפויה {percent(item.modelEstimatedSuccessProbability)} ·
                                                    האדם {item.actualHumanPressure.toFixed(2)} bar
                                                    {" "}({item.humanActualSuccess ? "הצליח בפועל" : "נדרש תיקון"}) ·
                                                    תמיכה {item.counterfactualSupportBatches} אצוות
                                                </span>
                                            </div>
                                        ))}
                                </div>
                            </>
                        )}
                    </article>
                </div>
            )}

            {(v6Result || v6Status) && (
                <div className="cellar-simulator-results">
                    <h3>V6 — אופטימיזציית מסלול קינטי</h3>
                    {v6Result ? (
                        <article className="cellar-simulator-result level-1">
                            <strong>
                                {v6Result.edgeCase === "head_pressure_insufficient"
                                    ? "מקרה קצה: לחץ ראש לא מספיק"
                                    : v6Result.edgeCase === "venting_below_zero"
                                        ? "מקרה קצה: נדרשת פריקה"
                                        : v6Result.action === "hold"
                                            ? "להשאיר לחץ"
                                            : v6Result.action === "raise"
                                                ? `להעלות לחץ ל-${v6Result.targetPressure?.toFixed(2)} bar`
                                                : `להוריד לחץ ל-${v6Result.targetPressure?.toFixed(2)} bar`}
                            </strong>
                            <p>
                                נמדד: {v6Result.measuredCarbonation.toFixed(3)} vol ·
                                עברו {v6Result.hoursSinceCarbonationMeasurement.toFixed(1)} שעות מאז הבדיקה ·
                                גיזוז משוער עכשיו: {v6Result.estimatedCurrentCarbonation.toFixed(3)} vol ·
                                k משולב: {v6Result.kPerHour.toFixed(5)}/שעה
                                {" "}({v6Result.kSource === "blended"
                                    ? "היסטוריה + האצווה הנוכחית"
                                    : v6Result.kSource === "current_batch"
                                        ? "האצווה הנוכחית"
                                        : v6Result.kSource === "historical"
                                            ? "אצוות דומות"
                                            : "fallback"}) ·
                                k היסטורי: {v6Result.historicalKPerHour !== null ? v6Result.historicalKPerHour.toFixed(5) : "—"} ·
                                k האצווה: {v6Result.currentBatchKPerHour !== null ? v6Result.currentBatchKPerHour.toFixed(5) : "—"} ·
                                תמיכת k: {v6Result.kHistoricalBatchCount} אצוות + {v6Result.kCurrentBatchIntervalCount} מקטעים באצווה ·
                                פריור מסלול היסטורי: {v6Result.historicalPressurePrior !== null ? `${v6Result.historicalPressurePrior.toFixed(2)} bar` : "—"} ·
                                תמיכה: {v6Result.supportCount} אצוות / {v6Result.supportSampleCount} דוגמאות ·
                                ביטחון: {v6Result.confidence} ·
                                טמפרטורת סיום: {v6Result.forecastTemperature.toFixed(1)}°C ·
                                עוד קירור משוער: {v6Result.coolingHoursRemaining.toFixed(0)} שעות ·
                                לחץ שיווי־משקל פיזיקלי של היעד {v6Result.targetCarbonation.toFixed(2)}: {v6Result.targetEquilibriumPressure.toFixed(2)} bar ·
                                אובדן לחץ תפעולי צפוי בדרך: {v6Result.expectedOperationalPressureLossBar.toFixed(2)} bar
                                {" "}ב-{v6Result.expectedPressureLossEvents} אירועים ·
                                מקור אובדן: {v6Result.operationalLossSource === "historical_one_action_courses"
                                    ? "קורסים היסטוריים מוצלחים ללא תיקון לחץ נוסף"
                                    : v6Result.operationalLossSource === "observed_yeast_drops"
                                        ? "הורדות שמרים שנמדדו באצווה"
                                        : v6Result.operationalLossSource === "yeast_drop_fallback"
                                            ? "הורדת שמרים קרה צפויה (fallback)"
                                            : "אין אובדן תפעולי עתידי מזוהה"} ·
                                בעוד 48 שעות בלי שינוי: {v6Result.predictedWithoutChange.toFixed(3)} vol ·
                                בסוף ללא שינוי: {v6Result.terminalCarbonationWithoutChange.toFixed(3)} vol
                                {" "}@ {v6Result.terminalPressureWithoutChange.toFixed(2)} bar ·
                                {v6Result.targetPressure !== null
                                    ? `לחץ פעולה: ${v6Result.targetPressure.toFixed(2)} bar · אחרי 48 שעות: ${v6Result.predictedAtTarget?.toFixed(3) ?? "—"} vol · סופי: ${v6Result.terminalCarbonationAtTarget?.toFixed(3) ?? "—"} vol @ ${v6Result.terminalPressureAtTarget?.toFixed(2) ?? "—"} bar`
                                    : `לחץ יעד מתמטי: ${v6Result.rawTargetPressure?.toFixed(2) ?? "—"} bar`}
                                {v6Result.terminalHoursAtTarget !== null
                                    ? ` · כניסה ראשונה לטווח היעד בעוד כ-${Math.round(v6Result.terminalHoursAtTarget)} שעות`
                                    : ""}
                            </p>
                        </article>
                    ) : (
                        <div className="cellar-simulator-empty">{v6Status}</div>
                    )}
                </div>
            )}

            {v6Result && (
                <div className="cellar-simulator-results">
                    <h3>
                        {v6Result.recommendationVisibility === "global"
                            ? "כך ההמלצה תופיע גם בהמלצות הכלליות ובמדד"
                            : "כך זה יופיע במסך המיכל בלבד"}
                    </h3>
                    <article className="cellar-simulator-result level-1">
                        <strong>
                            {v6Result.edgeCase === "head_pressure_insufficient"
                                ? "גיזוז מלמטה"
                                : v6Result.action === "hold"
                                    ? "להשאיר לחץ"
                                    : "שינוי לחץ"}
                        </strong>
                        <p>
                            {buildHypotheticalProductionPressureTextV6(
                                v6Result,
                                carbAgeDays,
                            )}
                        </p>
                    </article>
                </div>
            )}

            {result && (
                <div className="cellar-simulator-results">
                    <h3>המלצות שהמנוע היה מציג</h3>
                    {activeRecommendations.length === 0 ? (
                        <div className="cellar-simulator-empty">אין המלצה פעילה בתרחיש הזה.</div>
                    ) : (
                        activeRecommendations.map((recommendation) => (
                            <article
                                key={recommendation.key}
                                className={`cellar-simulator-result level-${recommendation.importance}`}
                            >
                                <strong>{recommendation.label}</strong>
                                <p>{recommendation.reason}</p>
                            </article>
                        ))
                    )}
                </div>
            )}
        </section>
    );
}
