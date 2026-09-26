import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, PencilSparkles } from "lucide-react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { sameStyle } from "../../SERVICES/planning/planningEngine";
import { getUndatedPlannedPackagingWeekForTank } from "../../SERVICES/planning/plannedPackagingForTanks";
import { loadRecipes } from "../../SERVICES/brewing/recipeEditorStore";
import { loadSharedBrewingLibrary } from "../../SERVICES/brewing/sharedBrewingLibrary";
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

function shortDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[3]}/${match[2]}` : value;
}

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
    const [brewRecipes, setBrewRecipes] = useState(() => loadRecipes());
    const [undatedPackagingWeeks, setUndatedPackagingWeeks] = useState<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;
        loadSharedBrewingLibrary()
            .then((library) => {
                if (!cancelled && library.hasRemoteLibrary) setBrewRecipes(library.recipes);
            })
            .catch((error) => console.warn("Failed loading brewing recipes for dashboard", error));
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const activeTanks = filteredBrews.filter(
            (tank) => Number(tank.tankNumber) > 1 && Number(tank.action) === 1,
        );

        Promise.all(activeTanks.map(async (tank) => {
            try {
                const result = await getUndatedPlannedPackagingWeekForTank({
                    tankId: tank.id,
                    tankNumber: tank.tankNumber,
                });
                return [tank.id, result?.weekStart || ""] as const;
            } catch (error) {
                console.warn("Failed loading undated packaging week", tank.tankNumber, error);
                return [tank.id, ""] as const;
            }
        })).then((entries) => {
            if (cancelled) return;
            setUndatedPackagingWeeks(Object.fromEntries(entries.filter(([, week]) => Boolean(week))));
        });

        return () => { cancelled = true; };
    }, [filteredBrews]);

    const recipeStyles = useMemo(
        () => brewRecipes.map((recipe) => ({ id: recipe.id, style: recipe.style })),
        [brewRecipes],
    );

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

    function openSheet(tank: Fermentor) {
        const url = String(tank.sheetUrl || "").trim();
        if (!url) return;
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isMobile) window.location.href = url;
        else window.open(url, "_blank", "noopener,noreferrer");
    }

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
                    const style = String(fermentor.beerStyle ?? "").trim();
                    const hasMatchingRecipe = !!style && recipeStyles.some((recipe) =>
                        sameStyle(recipe.style, style) || recipe.id.toLowerCase() === style.toLowerCase(),
                    );
                    const hasBrewSheet = !!String(fermentor.sheetUrl ?? "").trim();
                    const hasBatch = !!String(fermentor.batchNumber ?? "").trim();
                    const showBrewFormButton = Number(fermentor.tankNumber) > 1 && Number(fermentor.action) === 0;
                    const canOpenBrewForm = showBrewFormButton && hasBatch && hasBrewSheet && hasMatchingRecipe;
                    const disabledReason = !hasMatchingRecipe
                        ? "אין מתכון מתאים לסגנון הבירה"
                        : !hasBrewSheet
                            ? "טופס הבישול יהיה זמין לאחר יצירת ה-Sheet"
                            : !hasBatch
                                ? "חסר מספר אצווה"
                                : "מילוי טופס בישול";
                    const weekOnlyPackaging = undatedPackagingWeeks[fermentor.id] || "";

                    return (
                        <div
                            className={`dashboard-tank-slot${showBrewFormButton ? " dashboard-tank-slot-brew" : ""}`}
                            key={fermentor.id}
                        >
                            <TankCard
                                tank={fermentor}
                                onUpdatePasivation={handleUpdatePasivation}
                                specs={specs}
                                weekOnlyPackaging={weekOnlyPackaging ? shortDate(weekOnlyPackaging) : undefined}
                            />
                            {showBrewFormButton && (
                                <div className="dashboardBrewActionPair" aria-label="פעולות בישול">
                                    <button
                                        type="button"
                                        className="tankInfo dashboardBrewFormButton"
                                        aria-label="מילוי טופס בישול"
                                        title={canOpenBrewForm ? "מילוי טופס בישול" : disabledReason}
                                        disabled={!canOpenBrewForm}
                                        onClick={() => setBrewFormTank(fermentor)}
                                    >
                                        <PencilSparkles size={16} aria-hidden="true" />
                                    </button>
                                    {hasBrewSheet && (
                                        <button
                                            type="button"
                                            className="tankInfo dashboardBrewSheetButton"
                                            aria-label="פתיחת גיליון הבישול"
                                            title="פתיחת גיליון הבישול"
                                            onClick={() => openSheet(fermentor)}
                                        >
                                            <FileSpreadsheet size={16} aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
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
