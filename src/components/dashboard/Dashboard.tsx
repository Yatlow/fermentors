import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, PencilSparkles } from "lucide-react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { dateKey, sameStyle } from "../../SERVICES/planning/planningEngine";
import { subscribePlannedPackagingMaps } from "../../SERVICES/planning/plannedPackagingForTanks";
import { packagingIndicatorsForTanks, type PackagingMaps } from "../../SERVICES/planning/plannedPackagingProjection";
import { loadRecipes } from "../../SERVICES/brewing/recipeEditorStore";
import { loadSharedBrewingLibrary } from "../../SERVICES/brewing/sharedBrewingLibrary";
import HealthDashboard from "./HealthDashboard";
import SheetSyncStatus from "./SheetSyncStatus";
import TankCard from "./TankCard";
import DashboardBrewFormModal from "./DashboardBrewFormModal";

export type DashboardProps = {
    onlyWithCellarRecommendations?: boolean;
    recommendedTankNumbers?: string[];
    onRecommendedTanksChange?: (numbers: string[]) => void;
    onOpenRecommendationCountChange?: (count: number) => void;
    onPendingMeasurementTanksChange?: (tankNumbers: string[]) => void;
    sortMode?: "tank" | "oldest" | "newest" | "packagingSoon" | "packagingLater";
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
    sortMode = "tank",
    onlyWithCellarRecommendations = false,
    recommendedTankNumbers = [],
    onRecommendedTanksChange,
    onOpenRecommendationCountChange,
    onPendingMeasurementTanksChange,
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
    const [livePackaging, setLivePackaging] = useState<PackagingMaps | null>(null);
    // Preserve indicator object identity unless the actual date/weekly
    // assignment changed. HealthDashboard analyzes every tank when this prop
    // changes; pressure/temp readings must never trigger that work again.
    const [packagingDates, setPackagingDates] = useState<Record<string, string>>({});
    const [undatedPackagingWeeks, setUndatedPackagingWeeks] = useState<Record<string, string>>({});
    const packagingDay = dateKey(new Date());

    useEffect(() => {
        let cancelled = false;
        loadSharedBrewingLibrary()
            .then((library) => {
                if (!cancelled && library.hasRemoteLibrary) setBrewRecipes(library.recipes);
            })
            .catch((error) => console.warn("Failed loading brewing recipes for dashboard", error));
        return () => { cancelled = true; };
    }, []);

    // One live listener for all planned tank packaging. The server-confirmed
    // snapshot updates every dashboard card and packaging sort across devices.
    useEffect(() => {
        setLivePackaging(null);
        return subscribePlannedPackagingMaps(packagingDay, setLivePackaging, (error) => {
            console.warn("Failed syncing dashboard packaging plan", error);
            setLivePackaging(null);
        });
    }, [packagingDay]);

    // A stable physical identity, rather than the mutable Fermentor objects,
    // avoids recomputing the projected plan on every measurement update.
    const activePackagingIdentity = JSON.stringify((healthBrews ?? filteredBrews)
        .filter((tank) => Number(tank.tankNumber) > 1 && Number(tank.action) === 1)
        .map((tank) => [tank.id, tank.tankNumber, tank.batchNumber])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

    useEffect(() => {
        const identities = JSON.parse(activePackagingIdentity) as
            Array<[string, string | number | null, string | number | null]>;
        const { dates, undatedWeeks } = packagingIndicatorsForTanks(
            livePackaging,
            identities.map(([id, tankNumber, batchNumber]) => ({ id, tankNumber, batchNumber })),
        );
        const sameEntries = (previous: Record<string, string>, next: Record<string, string>) =>
            Object.keys(previous).length === Object.keys(next).length &&
            Object.entries(next).every(([key, value]) => previous[key] === value);
        setPackagingDates((previous) => sameEntries(previous, dates) ? previous : dates);
        setUndatedPackagingWeeks((previous) =>
            sameEntries(previous, undatedWeeks) ? previous : undatedWeeks);
    }, [livePackaging, activePackagingIdentity]);

    const displayBrews = useMemo(() => {
        const visible = onlyWithCellarRecommendations
            ? filteredBrews.filter((tank) => recommendedTankNumbers.includes(String(tank.tankNumber)))
            : filteredBrews;
        if (sortMode !== "packagingSoon" && sortMode !== "packagingLater") return visible;
        return [...visible].sort((a, b) => {
            const aDate = packagingDates[a.id] || "";
            const bDate = packagingDates[b.id] || "";
            if (!aDate) return bDate ? 1 : 0;
            if (!bDate) return -1;
            // Planning dates are ISO YYYY-MM-DD. Compare calendar days explicitly
            // so the first click (packagingSoon) always means earliest first.
            const aDay = Date.parse(`${aDate}T00:00:00`);
            const bDay = Date.parse(`${bDate}T00:00:00`);
            const difference = aDay - bDay;
            return sortMode === "packagingSoon" ? difference : -difference;
        });
    }, [filteredBrews, packagingDates, sortMode, onlyWithCellarRecommendations, recommendedTankNumbers]);

    const recipeStyles = useMemo(
        () => brewRecipes.map((recipe) => ({ id: recipe.id, style: recipe.style })),
        [brewRecipes],
    );

    const liveBrewFormTank = useMemo(() => {
        if (!brewFormTank) return null;
        const liveTanks = healthBrews ?? filteredBrews;
        return liveTanks.find((tank) => tank.id === brewFormTank.id) ?? null;
    }, [brewFormTank, healthBrews, filteredBrews]);

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
            <HealthDashboard brews={healthBrews ?? filteredBrews} specs={specs} plannedPackagingDates={packagingDates} onRecommendedTanksChange={onRecommendedTanksChange} onOpenRecommendationCountChange={onOpenRecommendationCountChange} onPendingMeasurementTanksChange={onPendingMeasurementTanksChange} />
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
                {specs && displayBrews.map((fermentor) => {
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
                            data-tank-number={fermentor.tankNumber}
                            key={fermentor.id}
                        >
                            <TankCard
                                tank={fermentor}
                                onUpdatePasivation={handleUpdatePasivation}
                                specs={specs}
                                weekOnlyPackaging={weekOnlyPackaging ? shortDate(weekOnlyPackaging) : undefined}
                                plannedPackagingDate={packagingDates[fermentor.id]}
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

            {liveBrewFormTank && (
                <DashboardBrewFormModal
                    tank={liveBrewFormTank}
                    onClose={() => setBrewFormTank(null)}
                />
            )}
        </div>
    );
}
