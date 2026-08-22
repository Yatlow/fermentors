import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Fermentor } from "../App"
import { getSpecsFromFb, type SpecChart } from "../SERVICES/getSpecsFromFb";
import TankCard from "./TankCard";




export type DashboardProps = {
    selectedStatuses: string[],
    filteredTankCount: number,
    totalVolumes: Record<string, number>,
    selectedStyles: string[],
    filteredBrews: Fermentor[],
    setSelectedStyles: Dispatch<SetStateAction<string[]>>,
    handleUpdatePasivation: (
        tankId: string,
        newDate: string
    ) => Promise<void>,
    //    specs:SpecChart
}

export default function Dashboard({
    selectedStatuses,
    filteredTankCount,
    totalVolumes,
    selectedStyles,
    filteredBrews,
    setSelectedStyles,
    handleUpdatePasivation,
    // specs,
}: DashboardProps) {

    const [specs, setSpecs] = useState<SpecChart | null>(null);

    const handleStyleToggle = (style: string): void => {
        if (style === "הכל") {
            setSelectedStyles(["הכל"]);
            return;
        }

        setSelectedStyles((prev) => {
            let nextState = prev.includes("הכל")
                ? []
                : [...prev];

            if (nextState.includes(style)) {
                nextState = nextState.filter(
                    (s) => s !== style
                );
            } else {
                nextState.push(style);
            }

            return nextState.length === 0
                ? ["הכל"]
                : nextState;
        });
    };

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

    return (
        <div className="dashboard">




            {/* FILTER INFO */}

            <div className="dashboard-filter-info">

                <span>
                    מציג מסננים:
                </span>

                <strong>
                    {selectedStatuses.includes(
                        "הכל"
                    )
                        ? "הכל"
                        : selectedStatuses.join(
                            ", "
                        )}
                </strong>

                <span className="filter-count-badge">
                    · {filteredTankCount} מיכלים
                </span>

            </div>
            <div className="volumeCounter">

                <span>
                    סיכום נפחים במיכלים:
                </span>

                {Object.entries(totalVolumes).map(
                    ([style, volume]) => (
                        <div
                            key={style}
                            className={`volume-filter ${selectedStyles.includes(style)
                                ? "active"
                                : ""
                                }`}
                            onClick={() =>
                                handleStyleToggle(style)
                            }
                        >
                            <span>{style}:</span>{" "}
                            {volume} ל'
                        </div>
                    )
                )}

                <div
                    className={`totalVolume ${selectedStyles.includes("הכל")
                        ? "active"
                        : ""
                        }`}
                    onClick={() =>
                        handleStyleToggle("הכל")
                    }
                >
                    סה״כ:{" "}
                    {Object.values(totalVolumes).reduce(
                        (total, volume) => total + volume,
                        0
                    )}{" "}
                    ל'
                </div>

            </div>

            {/* TANK GRID */}

            <div className="tank-grid">

                {specs && filteredBrews.map(
                    (fermentor) => (

                        <TankCard
                            key={fermentor.id}
                            tank={fermentor}
                            onUpdatePasivation={
                                handleUpdatePasivation
                            }
                            specs={specs}
                        />

                    )
                )}

            </div>


            {/* NO RESULTS */}

            {filteredBrews.length ===
                0 && (

                    <div className="no-tanks">

                        <p>
                            אין מיכלים העונים על
                            הסינון שנבחר
                        </p>

                    </div>

                )}

        </div>
    )
}