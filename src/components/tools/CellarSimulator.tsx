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
    estimatePressureTargetV5,
    type PressureV5Estimate,
} from "../../SERVICES/cellering/pressurePredictionV5";
import {
    getColdReferenceTemperatureV4,
    getEquilibriumPressureForV4,
    getPressurePredictionModelV4,
} from "../../SERVICES/cellering/pressurePredictionV4Model";
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

function buildHypotheticalProductionPressureTextV5(
    estimate: PressureV5Estimate,
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

    if (estimate.edgeCase === "bottom_carbonation") {
        return (
            intro +
            "לחץ ראש אינו מסלול הטיפול המתאים במקרה הזה. מומלץ לעבור למסלול גיזוז מלמטה ולבצע בדיקת גיזוז חוזרת לאחר הטיפול."
        );
    }

    if (estimate.edgeCase === "venting_below_zero") {
        return (
            intro +
            "גם הורדת לחץ הראש ל-0 bar אינה צפויה להספיק. מומלץ לעבור למסלול פריקה מבוקר ולבצע בדיקת גיזוז חוזרת לאחר הטיפול."
        );
    }

    if (estimate.edgeCase === "head_pressure_insufficient") {
        return (
            intro +
            "גם בלחץ הראש המקסימלי המותר לא צפוי להגיע לגיזוז התקין. מומלץ לעבור לגיזוז מלמטה ולבצע בדיקת גיזוז חוזרת לאחר הטיפול."
        );
    }

    if (estimate.targetPressure === null) {
        return (
            intro +
            "אין כרגע יעד לחץ אוטומטי אמין. מומלץ לבצע בדיקת גיזוז חוזרת."
        );
    }

    if (estimate.action === "raise") {
        return (
            intro +
            `מומלץ להעלות את הלחץ ל-${estimate.targetPressure.toFixed(2)} bar ` +
            "ולבצע בדיקת גיזוז חוזרת בעוד יומיים."
        );
    }

    if (estimate.action === "lower") {
        return (
            intro +
            `מומלץ להוריד את הלחץ ל-${estimate.targetPressure.toFixed(2)} bar ` +
            "ולבצע בדיקת גיזוז חוזרת בעוד יומיים."
        );
    }

    if (Math.abs(measured - target) <= 0.02) {
        return (
            `הגיזוז בבדיקה שנלקחה ${measurementDay} תקין ` +
            `(${measured.toFixed(2)}, גיזוז תקין ${target.toFixed(2)}). ` +
            `מומלץ להשאיר את הלחץ על ${estimate.targetPressure.toFixed(2)} bar.`
        );
    }

    return (
        intro +
        `מומלץ להשאיר את הלחץ על ${estimate.targetPressure.toFixed(2)} bar ` +
        "ולבצע בדיקת גיזוז חוזרת בעוד יומיים."
    );
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
    const [v5Result, setV5Result] = useState<PressureV5Estimate | null>(null);
    const [v5Status, setV5Status] = useState("");

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
        setV5Result(null);
        setV5Status("");
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
        setV5Result(null);
        setV5Status("");

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
                setV5Status("אין יעד גיזוז זמין לסגנון");
            } else {
                const v4Model = await getPressurePredictionModelV4(tank.beerStyle);
                if (!v4Model) {
                    setV5Status("אין מסמך מודל לחץ היסטורי לסגנון");
                } else {
                    const equilibriumForTemp = (temperature: number | null) =>
                        getEquilibriumPressureForV4(v4Model, temperature);

                    const state = buildPressureV4DecisionState({
                        measurements: simulated,
                        equilibriumPressure: equilibriumForTemp,
                    });

                    if (!state) {
                        setV5Status("אין מספיק נתוני מצב נוכחי לחישוב V5");
                    } else {
                        const coldReferenceTemperature =
                            getColdReferenceTemperatureV4(v4Model);

                        if (
                            state.currentTemp !== null &&
                            state.currentTemp > 9
                        ) {
                            setV5Status(
                                "המיכל עדיין חם מדי לחישוב לחץ גיזוז קר"
                            );
                        } else {
                            const v5Estimate = estimatePressureTargetV5({
                                samples: v4Model.samples,
                                passiveSamples: v4Model.passiveSamples,
                                transitions: v4Model.transitions,
                                state,
                                targetCarbonation: Number(carbonationTarget),
                                targetToleranceVol:
                                    specs.tolorances?.carbonation ?? 0.04,
                                coldReferenceTemperature,
                                firstCarbonation: carbonationScenario.first,
                                equilibriumPressureAtTemperature:
                                    equilibriumForTemp,
                            });
                            if (v5Estimate) {
                                setV5Result(v5Estimate);
                                setV5Status("");
                            } else {
                                setV5Status("לא ניתן לבנות חישוב V5 מהמצב הנוכחי");
                            }
                        }
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
                    <p>כלי Preview/פיתוח של V5 בלבד. קורא היסטוריה אמיתית, אך לא כותב ל-Firestore או ל-Sheets.</p>
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
                הזיהוי משנה את מסלול V5 בין בדיקה ראשונה/המשך קירור לבין בדיקה חוזרת.
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
                {tank && (
                    <span>
                        בסיס: {source.length} מדידות אמיתיות · אין שמירה של התרחיש
                    </span>
                )}
            </div>

            {error && <div className="cellar-simulator-error">{error}</div>}

            {(v5Result || v5Status) && (
                <div className="cellar-simulator-results">
                    <h3>V5 — מרחק משיווי־משקל</h3>
                    {v5Result ? (
                        <article className="cellar-simulator-result level-1">
                            <strong>
                                {v5Result.edgeCase === "bottom_carbonation"
                                    ? "מקרה קצה: גיזוז מלמטה"
                                    : v5Result.edgeCase === "venting_below_zero"
                                        ? "מקרה קצה: נדרשת פריקה"
                                        : v5Result.edgeCase === "head_pressure_insufficient"
                                            ? "מקרה קצה: גיזוז מלמטה — לחץ ראש לא מספיק"
                                            : v5Result.action === "hold"
                                                ? "להשאיר לחץ"
                                                : v5Result.action === "raise"
                                                    ? `להעלות לחץ ל-${v5Result.targetPressure?.toFixed(2)} bar`
                                                    : `להוריד לחץ ל-${v5Result.targetPressure?.toFixed(2)} bar`}
                            </strong>
                            <p>
                                מצב: {v5Result.mode === "first_cooling" ? "בדיקת גיזוז ראשונה / המשך קירור" : "מיכל קר יציב"} ·
                                נמדד: {v5Result.measuredCarbonation.toFixed(3)} vol ·
                                עברו {v5Result.hoursSinceCarbonationMeasurement.toFixed(1)} שעות מאז הבדיקה ·
                                גיזוז משוער עכשיו: {v5Result.estimatedCurrentCarbonation.toFixed(3)} vol ·
                                קצב מעבר: k={v5Result.kPerHour.toFixed(5)}/שעה
                                {" "}({
                                    v5Result.kSource === "learned"
                                        ? `נלמד מהמעברים${v5Result.rawLearnedKPerHour !== null ? ` · raw ${v5Result.rawLearnedKPerHour.toFixed(5)}` : ""}`
                                        : v5Result.kSource === "guarded"
                                            ? `k היסטורי נפסל${v5Result.rawLearnedKPerHour !== null ? ` (raw ${v5Result.rawLearnedKPerHour.toFixed(5)})` : ""}; משתמשים בכלל התפעולי`
                                            : "נגזר מכלל העבודה התפעולי"
                                }) ·
                                אפקט קינטי משוער ל-48 שעות: {v5Result.effectiveVolPerBar48h.toFixed(3)} vol/bar ·
                                תמיכה: {v5Result.supportCount} מעברים ·
                                ביטחון: {v5Result.confidence} ·
                                טמפרטורת חישוב: {v5Result.forecastTemperature.toFixed(1)}°C ·
                                לחץ שיווי־משקל של הגיזוז המשוער עכשיו: {v5Result.equilibriumPressureForCurrentCarb.toFixed(2)} bar ·
                                לחץ שיווי־משקל של יעד {v5Result.targetCarbonation.toFixed(2)}: {v5Result.targetEquilibriumPressure.toFixed(2)} bar ·
                                טולרנס גיזוז: ±{v5Result.targetToleranceVol.toFixed(2)} vol ·
                                מרחק הלחץ הנוכחי משיווי־משקל: {v5Result.pressureDistanceFromEquilibrium >= 0 ? "+" : ""}{v5Result.pressureDistanceFromEquilibrium.toFixed(2)} bar ·
                                בעוד 48 שעות בלי שינוי לחץ: {v5Result.predictedWithoutChange.toFixed(3)} vol
                                {v5Result.setpointBasis === "first_cooling_kinetic"
                                    ? ` · בסיס setpoint: אפקט קינטי 48h ${v5Result.setpointResponseVolPerBar.toFixed(3)} vol/bar`
                                    : ` · בסיס setpoint: תיקון אינקרמנטלי מהלחץ הנוכחי לפי ${v5Result.setpointResponseVolPerBar.toFixed(3)} vol/bar`}
                                {v5Result.targetPressureRangeLow !== null && v5Result.targetPressureRangeHigh !== null
                                    ? ` · טווח הגנה ${v5Result.operationalVolPerBarMin.toFixed(2)}–${v5Result.operationalVolPerBarMax.toFixed(2)} vol/bar: ${v5Result.targetPressureRangeLow.toFixed(2)}–${v5Result.targetPressureRangeHigh.toFixed(2)} bar`
                                    : ""}
                                {v5Result.rawTargetPressure !== null
                                    ? ` · לחץ יעד: ${v5Result.rawTargetPressure.toFixed(2)} bar`
                                    : ""}
                                {v5Result.predictedAtTarget !== null
                                    ? ` · יעד גיזוז בחישוב: ${v5Result.predictedAtTarget.toFixed(3)} vol`
                                    : ""}
                                {v5Result.edgeCase === "bottom_carbonation"
                                    ? ` · סף גיזוז מלמטה במסלול הזה: מתחת ${v5Result.mode === "first_cooling" ? "1.95" : "2.15"} vol. V5 רק מזהה את המסלול ולא מחשב טיפול.`
                                    : ""}
                                {v5Result.edgeCase === "venting_below_zero"
                                    ? " · הפתרון המתמטי דורש לחץ gauge שלילי; V5 רק מזהה שנדרשת פריקה ולא מחשב זמן."
                                    : ""}
                                {v5Result.edgeCase === "head_pressure_insufficient"
                                    ? " · הפתרון המתמטי דורש מעל 1.9 bar; V5 רק מסמן שלחץ ראש אינו פתרון מתאים."
                                    : ""}
                            </p>
                        </article>
                    ) : (
                        <div className="cellar-simulator-empty">{v5Status}</div>
                    )}
                </div>
            )}

            {v5Result && v5Result.action !== "hold" && (
                <div className="cellar-simulator-results">
                    <h3>כך ההמלצה הייתה נראית בפרודקשיין</h3>
                    <article className="cellar-simulator-result level-1">
                        <strong>
                            {v5Result.edgeCase === "bottom_carbonation" ||
                            v5Result.edgeCase === "head_pressure_insufficient"
                                ? "גיזוז מלמטה"
                                : "שינוי לחץ"}
                        </strong>
                        <p>
                            {buildHypotheticalProductionPressureTextV5(
                                v5Result,
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
