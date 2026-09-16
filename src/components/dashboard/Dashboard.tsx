import { type Dispatch, type SetStateAction } from "react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import HealthDashboard from "./HealthDashboard";
import SheetSyncStatus from "./SheetSyncStatus";
import TankCard from "./TankCard";

export type DashboardProps = {
    selectedStatuses: string[];
    filteredTankCount: number;
    totalVolumes: Record<string, number>;
    selectedStyles: string[];
    filteredBrews: Fermentor[];
    healthBrews?: Fermentor[];
    setSelectedStyles: Dispatch<SetStateAction<string[]>>;
    handleUpdatePasivation: (
        tankId: string,
        newDate: string
    ) => Promise<void>;
    specs: SpecChart | null;
};

export default function Dashboard({
    selectedStatuses,
    filteredTankCount,
    totalVolumes,
    selectedStyles,
    filteredBrews,
    healthBrews,
    setSelectedStyles,
    handleUpdatePasivation,
    specs,
}: DashboardProps) {
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

    return (
        <div className="dashboard">
            <HealthDashboard brews={healthBrews ?? filteredBrews} specs={specs} />
            <SheetSyncStatus />

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
