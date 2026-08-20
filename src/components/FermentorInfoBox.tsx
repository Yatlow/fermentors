import { useEffect, useState, useRef } from "react";
import type { Fermentor } from "../App";
import { getMeasurementsByBatch } from "../SERVICES/gettAllDataByBatch";
import { calcCelleringRecomendations } from "../SERVICES/calculateCelleringRecomendations";
import { getBrewAge } from "./TankCard";
import type { Measurement } from "../SERVICES/calculateCelleringRecomendations";
import type { SpecChart } from "../SERVICES/getSpecsFromFb";

type FermentorInfoBoxProps = {
    tank: Fermentor;
    onClose: () => void;

    position: {
        top: number;
        left: number;
    } | null;
    specs:SpecChart
};

type Recommendation = {
    req: boolean;
    reason?: string;
    importance: number;
};

type Recomendations = {
    requiresDailyActions:Recommendation;
    lastMessurmentUpToDate:Recommendation;
    requiresDryHop: Recommendation;
    requiresPresureClose: Recommendation;
    requiresWarmYeastDrop: Recommendation;
    requiersYeastDropAfterCooling: Recommendation;
    requiresCarbTest: Recommendation;
    requiersDiacytelRest: Recommendation;
    neglectedStatus: Recommendation;
    requiresToCoolDown: Recommendation;
    requiredPressureAdjustment: Recommendation;
};

export default function FermentorInfoBox({
    tank,
    onClose,
    position,
    specs
}: FermentorInfoBoxProps) {

    const [measurements, setMeasurements] =
        useState<Measurement[]>([]);

    const [recomendations, setRecomendations] =
        useState<Recomendations | null>(null);

    const [loading, setLoading] =
        useState(true);

    const [error, setError] =
        useState<string | null>(null);

    const brewAge = getBrewAge(tank.brewDate);

    const infoBoxRef = useRef<HTMLDivElement | null>(null);
    const getSafePosition = () => {

        const margin = 12;

        if (!position) {
            return {
                top: margin,
                left: margin
            };
        }

        const boxWidth = Math.min(
            330,
            window.innerWidth - margin * 2
        );

        const maxLeft =
            window.innerWidth - boxWidth - margin;

        return {
            top: Math.max(
                margin,
                Math.min(
                    position.top,
                    window.innerHeight - margin
                )
            ),

            left: Math.max(
                margin,
                Math.min(
                    position.left,
                    maxLeft
                )
            )
        };
    };
    const safePosition = getSafePosition();
    const isNewBatch =
        brewAge !== null &&
        brewAge < 2;
    // =========================================================
    // LOAD MEASUREMENTS
    // =========================================================
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

        document.addEventListener(
            "mousedown",
            handleOutsideClick
        );

        return () => {
            document.removeEventListener(
                "mousedown",
                handleOutsideClick
            );
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

                // -------------------------------------------------
                // GET MEASUREMENTS
                // -------------------------------------------------

                const data =
                    await getMeasurementsByBatch(
                        tank.batchNumber,
                        // tank.beerStyle,
                        // tank.brewDate
                    );
                setMeasurements(data);
                // -------------------------------------------------
                // CALCULATE RECOMMENDATIONS
                // -------------------------------------------------

                const calculatedRecommendations =
                    calcCelleringRecomendations(
                        data,
                        tank.beerStyle,
                        tank.batchNumber,
                        tank.brewDate,specs
                    );

                setRecomendations(
                    await calculatedRecommendations
                );
            } catch (err) {
                if (brewAge !== null && brewAge >= 2) {
                    console.error(
                        "Failed to load measurements:",
                        err
                    );

                    setError(
                        "לא ניתן לטעון את נתוני התסיסה"
                    );
                } else {
                    console.error(
                        "young batch:",
                    );

                    setError(
                        "אצווה חדשה- עדיין אין המלצות"
                    );

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
        tank.brewDate
    ]);


    // =========================================================
    // BUILD RECOMMENDATION LIST
    // =========================================================

    const recommendationList: Recommendation[] =
        recomendations
            ? [
                recomendations.requiresDailyActions,
                recomendations.lastMessurmentUpToDate,
                recomendations.requiresDryHop,
                recomendations.requiresPresureClose,
                recomendations.requiresWarmYeastDrop,
                recomendations.requiersYeastDropAfterCooling,
                recomendations.requiresCarbTest,
                recomendations.requiersDiacytelRest,
                recomendations.neglectedStatus,
                recomendations.requiresToCoolDown,
                recomendations.requiredPressureAdjustment
            ]
            : [];


    const activeRecommendations =
        recommendationList
            .filter(rec => rec.req)
            .sort(
                (a, b) =>
                    b.importance - a.importance
            );


    // =========================================================
    // RENDER
    // =========================================================



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


                {/* ================================================= */}
                {/* TITLE */}
                {/* ================================================= */}

                <h3>
                    המלצות סלרינג למיכל {tank.tankNumber}
                </h3>


                {/* ================================================= */}
                {/* LOADING */}
                {/* ================================================= */}

                {loading && (

                    <div className="measurementLoading">
                        טוען נתוני תסיסה...
                    </div>

                )}


                {/* ================================================= */}
                {/* ERROR */}
                {/* ================================================= */}

                {!loading && error && (

                    <div className="measurementError">
                        {error}
                    </div>

                )}


                {/* ================================================= */}
                {/* NO MEASUREMENTS */}
                {/* ================================================= */}
                {!loading &&
                    isNewBatch && measurements.length < 1 && (

                        <div className="newBatchMessage">

                            <div className="newBatchTitle">
                                אצווה חדשה
                            </div>

                            <div className="newBatchText">
                                אין המלצות סלרינג עדיין
                            </div>

                        </div>

                    )}

                {!loading &&
                    !error &&
                    brewAge !== null && brewAge >= 2 &&
                    measurements.length === 0 && (

                        <div className="measurementEmpty">
                            אין נתוני מדידות עבור אצווה זו
                        </div>

                    )
                }


                {/* ================================================= */}
                {/* RECOMMENDATIONS */}
                {/* ================================================= */}

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

                                activeRecommendations.map(
                                    (rec, index) => (

                                        <div
                                            key={index}
                                            className={`recommendation level-${rec.importance}`}
                                        >
                                            {rec.reason}
                                        </div>

                                    )
                                )

                            )}

                        </div>
                    )
                }
            </div>
        </div>


    );
}