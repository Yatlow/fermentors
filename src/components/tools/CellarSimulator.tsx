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
    estimatePressureTargetV4,
    type PressureV4Estimate,
} from "../../SERVICES/cellering/pressurePredictionV4Estimator";
import {
    getColdReferenceTemperatureV4,
    getEquilibriumPressureForV4,
    getPressurePredictionModelV4,
} from "../../SERVICES/cellering/pressurePredictionV4Model";
import {
    estimateVentingDuration,
    type VentingEstimate,
} from "../../SERVICES/cellering/ventingEstimator";
import "./CellarSimulator.css";

type Treatment = "none" | "ordinaryPressure" | "bottomCarbonation";
type StageMode = "actual" | "cold" | "warm";
type CarbonationScenarioMode = "auto" | "first" | "subsequent";

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

function buildHypotheticalProductionPressureText(
    estimate: PressureV4Estimate,
    currentCarbonation: number,
    venting: VentingEstimate | null,
): string {
    const targetRange =
        `${estimate.targetWindowMin.toFixed(2)}–${estimate.targetWindowMax.toFixed(2)}`;

    if (estimate.decisionStatus === "pressure_only_insufficient") {
        const directionText =
            currentCarbonation < estimate.targetCarbonation
                ? "הגיזוז נמוך"
                : "הגיזוז גבוה";
        if (
            currentCarbonation > estimate.targetCarbonation &&
            venting
        ) {
            return (
                `${directionText} (${currentCarbonation.toFixed(2)}, יעד ${estimate.targetCarbonation.toFixed(2)}). ` +
                `לפי מודל V4 שינוי לחץ ראש בלבד לא צפוי להביא את הגיזוז לטווח ${targetRange} בתוך יומיים. ` +
                `מומלץ לפתוח ל-${venting.ventPressureBar.toFixed(2)} bar למשך כ-${venting.durationMinutes} דקות, ` +
                `ואז לסגור מחדש ולבצע בדיקת גיזוז חוזרת. התחזית בסיום האוורור: ${venting.predictedCarbonationAtClose.toFixed(3)}.`
            );
        }

        const nextAction =
            currentCarbonation < estimate.targetCarbonation
                ? "מומלץ לשקול גיזוז מלמטה"
                : "מומלץ לבצע הורדת לחץ/שחרור בהתאם";

        return (
            `${directionText} (${currentCarbonation.toFixed(2)}, יעד ${estimate.targetCarbonation.toFixed(2)}). ` +
            `לפי מודל V4 שינוי לחץ ראש בלבד לא צפוי להביא את הגיזוז לטווח ${targetRange} בתוך יומיים. ` +
            `${nextAction} ולבצע בדיקת גיזוז חוזרת.`
        );
    }

    const actionText =
        estimate.action === "hold"
            ? `להשאיר את הלחץ על ${estimate.targetPressure.toFixed(2)} bar`
            : estimate.action === "raise"
                ? `להעלות את הלחץ ל-${estimate.targetPressure.toFixed(2)} bar`
                : `להוריד את הלחץ ל-${estimate.targetPressure.toFixed(2)} bar`;

    if (estimate.decisionStatus === "early_cooling_exception") {
        return (
            `הגיזוז בבדיקה אינו בטווח היעד (${currentCarbonation.toFixed(2)}, יעד ${estimate.targetCarbonation.toFixed(2)}). ` +
            `המיכל עדיין בתהליך קירור; מומלץ ${actionText}. ` +
            `תחזית הגיזוז לעוד יומיים היא ${estimate.predictedCarbonation.toFixed(3)}, מחוץ לטווח ${targetRange}, ` +
            "ולכן מומלץ לבצע בדיקת גיזוז חוזרת בעוד יומיים."
        );
    }

    return (
        `הגיזוז בבדיקה אינו בטווח היעד (${currentCarbonation.toFixed(2)}, יעד ${estimate.targetCarbonation.toFixed(2)}). ` +
        `מומלץ ${actionText} ולבצע בדיקת גיזוז חוזרת בעוד יומיים. ` +
        `תחזית V4 לאחר הפעולה: ${estimate.predictedCarbonation.toFixed(3)}.`
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

    if (args.carbAgeDays === 0) {
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
    const [v4Result, setV4Result] = useState<PressureV4Estimate | null>(null);
    const [v4Status, setV4Status] = useState("");
    const [v4CoolingStatus, setV4CoolingStatus] = useState("");
    const [ventingResult, setVentingResult] = useState<VentingEstimate | null>(null);

    const [carbonation, setCarbonation] = useState("2.10");
    const [pressure, setPressure] = useState("");
    const [temp, setTemp] = useState("");
    const [plato, setPlato] = useState("");
    const [carbAgeDays, setCarbAgeDays] = useState(0);
    const [treatment, setTreatment] = useState<Treatment>("none");
    const [carbonationScenarioMode, setCarbonationScenarioMode] =
        useState<CarbonationScenarioMode>("auto");
    const [stageMode, setStageMode] = useState<StageMode>("actual");

    const tank = tanks.find((item) => item.id === tankId) ?? null;

    useEffect(() => {
        setResult(null);
        setV4Result(null);
        setV4Status("");
        setV4CoolingStatus("");
        setVentingResult(null);
        setVentingResult(null);
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
        setV4Result(null);
        setV4Status("");
        setV4CoolingStatus("");
        setVentingResult(null);

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
                setV4Status("אין יעד גיזוז זמין לסגנון");
            } else {
                const v4Model = await getPressurePredictionModelV4(tank.beerStyle);
                if (!v4Model || v4Model.transitions.length < 4) {
                    const count = v4Model?.transitions.length ?? 0;
                    setV4Status(
                        `נמצאו ${count} מעברים קינטיים; נדרשים לפחות 4. המודל עדיין ממתין לסריקת ההיסטוריה.`
                    );
                } else {
                    const equilibriumForTemp = (temperature: number | null) =>
                        getEquilibriumPressureForV4(v4Model, temperature);

                    const state = buildPressureV4DecisionState({
                        measurements: simulated,
                        equilibriumPressure: equilibriumForTemp,
                    });

                    if (!state) {
                        setV4Status("אין מספיק היסטוריית לחץ/גיזוז לבניית מצב V4");
                    } else {
                        setV4CoolingStatus(
                            state.cooling
                                ? `${Math.round(state.cooling.hoursSinceCooling)} שעות מאז קירור${state.cooling.stillCooling ? " · עדיין מתקרר" : ""}`
                                : "אין אירוע קירור מזוהה"
                        );
                        const coldReferenceTemperature =
                            getColdReferenceTemperatureV4(v4Model);
                        const referenceTemperature =
                            state.cooling?.stillCooling &&
                            coldReferenceTemperature !== null &&
                            state.currentTemp !== null &&
                            coldReferenceTemperature < state.currentTemp
                                ? coldReferenceTemperature
                                : state.currentTemp;

                        if (
                            state.currentTemp !== null &&
                            state.currentTemp > 9
                        ) {
                            setV4Status(
                                "המיכל עדיין חם מדי לחישוב לחץ גיזוז קר"
                            );
                        } else {
                            const estimate = estimatePressureTargetV4({
                                samples: v4Model.samples,
                                passiveSamples: v4Model.passiveSamples,
                                transitions: v4Model.transitions,
                                state,
                                targetCarbonation: Number(carbonationTarget),
                                equilibriumPressure:
                                    equilibriumForTemp(referenceTemperature),
                                equilibriumPressureAtTemperature:
                                    equilibriumForTemp,
                                coldReferenceTemperature,
                            });
                            if (estimate) {
                                setV4Result(estimate);
                                setV4Status("");

                                const venting =
                                    carbonationValue >
                                    estimate.targetWindowMax
                                        ? estimateVentingDuration({
                                            transitions:
                                                v4Model.transitions,
                                            state,
                                            targetCarbonation:
                                                Number(carbonationTarget),
                                            ventPressureBar: 0,
                                        })
                                        : null;
                                setVentingResult(venting);
                            } else {
                                setV4Status(
                                    "אין מספיק מצבים היסטוריים דומים להמלצת V4"
                                );
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
                    <p>כלי Preview/פיתוח בלבד. קורא היסטוריה אמיתית, אך לא כותב ל-Firestore או ל-Sheets.</p>
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
                הזיהוי משנה רק את ההיסטוריה המדומה; מנוע V4 עצמו לא מקבל כלל מיוחד ל"גיזוז ראשון".
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

            {v4Result && (
                <div className="cellar-simulator-results">
                    <h3>כך ההמלצה הייתה נראית בפרודקשיין</h3>
                    <article className="cellar-simulator-result level-1">
                        <strong>שינוי לחץ</strong>
                        <p>
                            {buildHypotheticalProductionPressureText(
                                v4Result,
                                Number(carbonation),
                                ventingResult,
                            )}
                        </p>
                    </article>
                </div>
            )}

            {(v4Result || v4Status) && (
                <div className="cellar-simulator-results">
                    <h3>V4 ניסיוני</h3>
                    {ventingResult && (
                        <article className="cellar-simulator-result level-1">
                            <strong>מנוע אוורור / הורדת גיזוז</strong>
                            <p>
                                פתיחה ל-{ventingResult.ventPressureBar.toFixed(2)} bar
                                {" "}לכ-{ventingResult.durationMinutes} דקות ·
                                תחזית בסגירה: {ventingResult.predictedCarbonationAtClose.toFixed(3)} ·
                                יעד: {ventingResult.targetWindowMin.toFixed(2)}–
                                {ventingResult.targetWindowMax.toFixed(2)} ·
                                תמיכה: {ventingResult.supportCount} מעברי ירידת גיזוז ·
                                ביטחון: {ventingResult.confidence}
                            </p>
                        </article>
                    )}

                    {v4Result ? (
                        <article className="cellar-simulator-result level-1">
                            <strong>מודל לחץ V4</strong>
                            <p>
                                פעולה: {
                                    v4Result.action === "hold"
                                        ? "להשאיר לחץ"
                                        : v4Result.action === "raise"
                                            ? "להעלות לחץ"
                                            : "להוריד לחץ"
                                } ·
                                יעד לחץ: {v4Result.targetPressure} bar ·
                                שיווי־משקל תפעולי: {v4Result.targetEquilibriumPressure?.toFixed(2) ?? "—"} bar
                                ({v4Result.referenceTemperature?.toFixed(1) ?? "—"}°C) ·
                                headroom: {v4Result.headroomBar >= 0 ? "+" : ""}{v4Result.headroomBar} bar ·
                                ללא שינוי לחץ: {v4Result.predictedCarbonationWithoutChange} בעוד יומיים ·
                                אחרי הפעולה: {v4Result.predictedCarbonation} ·
                                יעד גיזוז: {v4Result.targetCarbonation}
                                {" "}(
                                {(v4Result.targetCarbonation - 0.02).toFixed(2)}
                                –
                                {(v4Result.targetCarbonation + 0.02).toFixed(2)}
                                ) ·
                                ביטחון: {v4Result.confidence} ·
                                דיוק היסטורי: {v4Result.accuracyPercent}% ·
                                k לחיזוי בלבד: {v4Result.kPerHour}/שעה ·
                                {v4CoolingStatus} ·
                                תמיכה: {v4Result.supportCount} מעברים
                                {v4Result.headroomSupport > 0
                                    ? ` · headroom היסטורי: ${v4Result.headroomSupport} דוגמאות`
                                    : ""}
                                {" · "}
                                סטטוס החלטה: {
                                    v4Result.decisionStatus === "within_window"
                                        ? "תחזית בתוך חלון היעד"
                                        : v4Result.decisionStatus === "early_cooling_exception"
                                            ? "חריג קירור פעיל — התחזית יכולה להיות מחוץ לחלון"
                                            : "אין פתרון מספק בלחץ ראש בלבד"
                                }
                                {v4Result.pressureOnlyLikelyInsufficient
                                    ? " · לחץ ראש בלבד לא צפוי להספיק"
                                    : ""}
                            </p>
                        </article>
                    ) : (
                        <div className="cellar-simulator-empty">{v4Status}</div>
                    )}
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
