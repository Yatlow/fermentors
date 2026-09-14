import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { db } from "../../firebase";
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
}

export default function Dashboard({
    selectedStatuses,
    filteredTankCount,
    totalVolumes,
    selectedStyles,
    filteredBrews,
    setSelectedStyles,
    handleUpdatePasivation,
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
                nextState = nextState.filter((s) => s !== style);
            } else {
                nextState.push(style);
            }

            return nextState.length === 0 ? ["הכל"] : nextState;
        });
    };

    // Keep dashboard specs live. This matters for dry-hop aa defaults because
    // the hops document may be added/edited while the dashboard is already open.
    useEffect(() => {
        const specsRef = collection(db, "specs");
        const unsubscribe = onSnapshot(
            specsRef,
            (snapshot) => {
                const nextSpecs: SpecChart = {};
                snapshot.docs.forEach((firebaseDoc) => {
                    nextSpecs[firebaseDoc.id] = firebaseDoc.data() as Record<string, number>;
                });
                setSpecs(nextSpecs);
            },
            (error) => {
                console.error("Failed to subscribe to dashboard specs:", error);
            }
        );

        return unsubscribe;
    }, []);

    return (
        <div className="dashboard">
            <div className="dashboard-filter-info">
                <span>מציג מסננים:</span>
                <strong>
                    {selectedStatuses.includes("הכל")
                        ? "הכל"
                        : selectedStatuses.join(", ")}
                </strong>
                <span className="filter-count-badge">
                    · {filteredTankCount} מיכלים
                </span>
            </div>

            <div className="volumeCounter">
                <span>סיכום נפחים במיכלים:</span>

                {Object.entries(totalVolumes).map(([style, volume]) => (
                    <div
                        key={style}
                        className={`volume-filter ${selectedStyles.includes(style) ? "active" : ""}`}
                        onClick={() => handleStyleToggle(style)}
                    >
                        <span>{style}:</span>{" "}
                        {volume} ל'
                    </div>
                ))}

                <div
                    className={`totalVolume ${selectedStyles.includes("הכל") ? "active" : ""}`}
                    onClick={() => handleStyleToggle("הכל")}
                >
                    סה״כ:{" "}
                    {Object.values(totalVolumes).reduce((total, volume) => total + volume, 0)}{" "}
                    ל'
                </div>
            </div>

            <div className="tank-grid">
                {specs && filteredBrews.map((fermentor) => (
                    <TankCard
                        key={fermentor.id}
                        tank={fermentor}
                        onUpdatePasivation={handleUpdatePasivation}
                        specs={specs}
                    />
                ))}
            </div>

            {filteredBrews.length === 0 && (
                <div className="no-tanks">
                    <p>אין מיכלים העונים על הסינון שנבחר</p>
                </div>
            )}
        </div>
    );
}
