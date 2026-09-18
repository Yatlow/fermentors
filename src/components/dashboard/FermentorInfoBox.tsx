import BeerLoader from "../general/Loading";
import { useEffect, useRef, useState } from "react";
import type { Fermentor } from "../../App";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import {
    calcCelleringRecomendations,
    type Measurement,
} from "../../SERVICES/cellering/calculateCelleringRecomendations";
import { findOpenBottomCarbonation } from "../../SERVICES/cellering/bottomCarbonation";
import { getBrewAge } from "./TankCard";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import {
    dueScheduledForTank,
    scheduledActionLabel,
    subscribeScheduledCellarRecommendations,
    type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import ScheduledCellarRecommendationsPanel, {
    type NaturalFutureCellarRecommendation,
} from "./ScheduledCellarRecommendationsPanel";

type FermentorInfoBoxProps = {
    tank: Fermentor;
    onClose: () => void;
    position: {
        top: number;
        left: number;
    } | null;
    specs: SpecChart;
};

type Recomendations = Awaited<ReturnType<typeof calcCelleringRecomendations>>;
type Recommendation = {
    req: boolean;
    reason?: string;
    importance: number;
    display: boolean;
};

function futureDateFromReason(reason: string): string | undefined {
    let days: number | null = null;
    const inDays = reason.match(/בעוד\s+(\d+)\s+ימים?/);
    if (inDays) days = Number(inDays[1]);
    else if (reason.includes("מחר")) days = 1;
    if (days === null || !Number.isFinite(days)) return undefined;

    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function naturalFutureRecommendations(
    recommendations: Recomendations | null,
): NaturalFutureCellarRecommendation[] {
    if (!recommendations) return [];

    const candidates = [
        {
            id: "natural-future-carb",
            actionType: "carbTest" as const,
            recommendation: recommendations.requiresCarbTest,
            label: "בדיקת גיזוז",
        },
        {
            id: "natural-future-yeast",
            actionType: "yeastDrop" as const,
            recommendation: recommendations.requiresWarmYeastDrop,
            label: "הורדת שמרים",
        },
    ];

    return candidates.flatMap(({ id, actionType, recommendation, label }) => {
        const reason = String(recommendation?.reason ?? "").trim();
        const isKnownFuture =
            recommendation?.req === true &&
            recommendation?.display === false &&
            /בעוד\s+\d+\s+ימים?|מחר|שבוע הבא/.test(reason);

        return isKnownFuture
            ? [{
                id,
                actionType,
                label,
                dueDate: futureDateFromReason(reason),
                detail: reason,
            }]
            : [];
    });
}

export default function FermentorInfoBox({
    tank,
    onClose,
    position,
    specs,
}: FermentorInfoBoxProps) {
    const [measurements, setMeasurements] = useState<Measurement[]>([]);
    const [recomendations, setRecomendations] = useState<Recomendations | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [scheduledRecommendations, setScheduledRecommendations] = useState<ScheduledCellarRecommendation[]>([]);

    const brewAge = getBrewAge(tank.brewDate);
    const infoBoxRef = useRef<HTMLDivElement | null>(null);

    const getSafePosition = () => {
        const margin = 12;

        if (!position) {
            return {
                top: margin,
                left: margin,
            };
        }

        const boxWidth = Math.min(330, window.innerWidth - margin * 2);
        const maxLeft = window.innerWidth - boxWidth - margin;

        return {
            top: Math.max(
                margin,
                Math.min(position.top, window.innerHeight - margin)
            ),
            left: Math.max(
                margin,
                Math.min(position.left, maxLeft)
            ),
        };
    };

    const safePosition = getSafePosition();
    const isNewBatch = brewAge !== null && brewAge < 2;

    useEffect(() => {
        return subscribeScheduledCellarRecommendations(
            setScheduledRecommendations,
            (error) => console.error("Failed loading scheduled cellar recommendations:", error),
        );
    }, []);

    useEffect(() => {
        function handleOutsideClick(event: MouseEvent) {
            const target = event.target as Node;

            if (
                infoBoxRef.current &&
                !infoBoxRef.current.contains(target)
            ) {
                onClose();
            }
        }

        document.addEventListener("mousedown", handleOutsideClick);

        return () => {
            document.removeEventListener("mousedown", handleOutsideClick);
        };
    }, [onClose]);

    useEffect(() => {
        async function loadMeasurements() {
            if (!tank.batchNumber || !tank.brewDate) {
                setMeasurements([]);
                setRecomendations(null);
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                setError(null);

                if (!tank.stage) {
                    setRecomendations(null);
                    setError("לא ניתן לחשב המלצות: שלב המיכל אינו מוגדר");
                    setLoading(false);
                    return;
                }

                const data = await getMeasurementsByBatch(tank.batchNumber);
                setMeasurements(data);

                const calculatedRecommendations = calcCelleringRecomendations(
                    data,
                    tank.beerStyle,
                    tank.brewDate,
                    specs,
                    tank.stage,
                    Number(tank.tankNumber),
                    true,
                    []
                );

                setRecomendations(await calculatedRecommendations);
            } catch (err) {
                if (brewAge !== null && brewAge >= 2) {
                    console.error("Failed to load measurements:", err);
                    setError("לא ניתן לטעון את נתוני התסיסה");
                } else {
                    console.error("young batch:");
                    setError("אצווה חדשה- עדיין אין המלצות");
                }

                setMeasurements([]);
                setRecomendations(null);
            } finally {
                setLoading(false);
            }
        }

        loadMeasurements();
    }, [
        tank.batchNumber,
        tank.beerStyle,
        tank.brewDate,
        tank.stage,
        tank.tankNumber,
        specs,
        brewAge,
    ]);

    const openBottomCarbonation = findOpenBottomCarbonation(measurements);
    const naturalCarbRecommendation = Boolean(
        recomendations?.requiresCarbTest?.req && recomendations?.requiresCarbTest?.display
    );
    const naturalYeastRecommendation = Boolean(
        (recomendations?.requiresWarmYeastDrop?.req && recomendations?.requiresWarmYeastDrop?.display) ||
        (recomendations?.requiersYeastDropAfterCooling?.req && recomendations?.requiersYeastDropAfterCooling?.display) ||
        (recomendations?.requiresWarmYeastDropCompletion?.req && recomendations?.requiresWarmYeastDropCompletion?.display) ||
        (recomendations?.requiresColdYeastDropCompletion?.req && recomendations?.requiresColdYeastDropCompletion?.display) ||
        (recomendations?.requiiersWedYeastDropOnThus?.req && recomendations?.requiiersWedYeastDropOnThus?.display)
    );
    const naturalFuture = naturalFutureRecommendations(recomendations);

    const dueManualRecommendations = dueScheduledForTank(
        scheduledRecommendations,
        tank.tankNumber,
        tank.batchNumber,
    ).filter((row) => (
        row.actionType === "carbTest"
            ? !naturalCarbRecommendation
            : !naturalYeastRecommendation
    ));

    const recommendationList: Recommendation[] = [
        ...(recomendations
            ? [
                recomendations.lastMessurmentUpToDate,
                recomendations.requiresDryHop,
                recomendations.requiresPresureClose,
                recomendations.requiresWarmYeastDrop,
                recomendations.requiersYeastDropAfterCooling,
                recomendations.requiresCarbTest,
                recomendations.requiersDiacytelRest,
                recomendations.neglectedStatus,
                recomendations.requiresToCoolDown,
                recomendations.requiredPressureAdjustment,
                recomendations.requiresWarmYeastDropCompletion,
                recomendations.requiresColdYeastDropCompletion,
                recomendations.requiiersWedYeastDropOnThus,
            ]
                .filter(Boolean)
                .map((rec) => ({
                    req: Boolean(rec.req),
                    reason: rec.reason,
                    importance: rec.importance,
                    display: Boolean(rec.display),
                }))
            : []),
        ...(openBottomCarbonation && tank.stage?.name === "קר"
            ? [{
                req: true,
                reason: "גיזוז מלמטה עדיין פתוח — מומלץ לסגור ולדווח שעת סגירה ולחץ.",
                importance: 2,
                display: true,
            }]
            : []),
        ...dueManualRecommendations.map((row) => ({
            req: true,
            reason: `המלצה מתוזמנת: ${scheduledActionLabel(row.actionType)}${row.note ? ` — ${row.note}` : ""}`,
            importance: 3,
            display: true,
        })),
    ];

    const activeRecommendations = recommendationList
        .filter((rec) => rec.req && rec.display)
        .sort((a, b) => b.importance - a.importance);

    return (
        <div
            className="fermentorInfoOverlay"
            onClick={(event) => {
                event.stopPropagation();
                onClose();
            }}
        >
            <div
                ref={infoBoxRef}
                className="fermentorInfoBox"
                style={{
                    top: safePosition.top,
                    left: safePosition.left,
                }}
                onClick={(event) => {
                    event.stopPropagation();
                }}
            >
                <button
                    type="button"
                    className="fermentorInfoClose"
                    aria-label="סגירה"
                    onClick={(event) => {
                        event.stopPropagation();
                        onClose();
                    }}
                >
                    ×
                </button>

                <h3>המלצות סלרינג למיכל {tank.tankNumber}</h3>

                {loading && (
                    <div className="measurementLoading">
                        <BeerLoader message="טוען נתוני תסיסה..." size="small" />
                    </div>
                )}

                {!loading && error && (
                    <div className="measurementError">
                        {error}
                    </div>
                )}

                {!loading && isNewBatch && measurements.length < 1 && (
                    <div className="newBatchMessage">
                        <div className="recommendation level-0">
                            אצווה חדשה
                            אין המלצות סלרינג עדיין
                        </div>
                    </div>
                )}

                {!loading &&
                    !error &&
                    brewAge !== null &&
                    brewAge >= 2 &&
                    measurements.length === 0 && (
                        <div className="recommendation level-0">
                            אין נתוני מדידות עבור אצווה זו
                        </div>
                    )}

                {!loading &&
                    !error &&
                    measurements.length > 0 &&
                    recomendations && (
                        <div className="recomendationsContainer">
                            {activeRecommendations.length === 0 ? (
                                <div className="noRecommendations">
                                    אין המלצות כרגע
                                </div>
                            ) : (
                                activeRecommendations.map((rec, index) => (
                                    <div
                                        key={index}
                                        className={`recommendation level-${rec.importance}`}
                                    >
                                        {rec.reason}
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                {tank.batchNumber && Number(tank.tankNumber) > 1 && (
                    <ScheduledCellarRecommendationsPanel
                        tankNumber={tank.tankNumber ?? tank.id}
                        batchNumber={tank.batchNumber}
                        rows={scheduledRecommendations}
                        naturalFuture={naturalFuture}
                    />
                )}
            </div>
        </div>
    );
}
