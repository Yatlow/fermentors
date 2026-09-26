import { type Dispatch, type SetStateAction, useState } from "react";
import { PencilSparkles } from "lucide-react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import HealthDashboard from "./HealthDashboard";
import SheetSyncStatus from "./SheetSyncStatus";
import TankCard from "./TankCard";
import DashboardBrewFormModal from "./DashboardBrewFormModal";

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
    const [brewFormTank, setBrewFormTank] = useState<Fermentor | null>(null);

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
                {specs && filteredBrews.map((fermentor) => {
                    const canOpenBrewForm =
                        Number(fermentor.tankNumber) > 1 &&
                        Number(fermentor.action) === 0 &&
                        !!String(fermentor.batchNumber ?? "").trim() &&
                        !!String(fermentor.beerStyle ?? "").trim() &&
                        !!String(fermentor.sheetUrl ?? "").trim();
                    const showBrewFormButton = Number(fermentor.tankNumber) > 1 && Number(fermentor.action) === 0;

                    return (
                        <div className="dashboard-tank-slot" key={fermentor.id}>
                            <TankCard
                                tank={fermentor}
                                onUpdatePasivation={handleUpdatePasivation}
                                specs={specs}
                            />
                            {showBrewFormButton && (
                                <button
                                    type="button"
                                    className="dashboardBrewFormButton"
                                    aria-label="מילוי טופס בישול"
                                    title={canOpenBrewForm ? "מילוי טופס בישול" : "טופס הבישול יהיה זמין לאחר יצירת ה-Sheet"}
                                    disabled={!canOpenBrewForm}
                                    onClick={() => setBrewFormTank(fermentor)}
                                >
                                    <PencilSparkles size={16} aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>

            {filteredBrews.length === 0 && (
                <div className="no-tanks">
                    <p>אין מיכלים העונים על הסינון שנבחר</p>
                </div>
            )}

            {brewFormTank && (
                <DashboardBrewFormModal
                    tank={brewFormTank}
                    onClose={() => setBrewFormTank(null)}
                />
            )}
        </div>
    );
}
