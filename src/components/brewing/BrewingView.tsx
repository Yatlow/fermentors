import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import {
    serverListBrewDriveHistory,
    type BrewingDriveHistoryRow,
} from "../../SERVICES/brewing/brewingSheetServer";
import { loadSandboxRecipes } from "../../SERVICES/brewing/sandboxRecipe";
import { loadSandboxIngredients } from "../../SERVICES/brewing/sandboxIngredients";
import {
    getCurrentWeekPlannedBrewHints,
    type PlannedBrewHint,
} from "../../SERVICES/brewing/planningBrewHints";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import { addDays, parseDate, sameStyle } from "../../SERVICES/planning/planningEngine";
import {
    assignNextSandboxRunToTank,
    attachSandboxRecipeSnapshot,
    attachSandboxSheet,
    createSandboxBrewRun,
    deleteSandboxBrewRun,
    isBrewingSandbox,
    loadSandboxBrewRuns,
    loadSandboxDemoTank,
    markSandboxDemoTankBrewing,
    resetSandboxDemoTank,
    setSandboxDemoTankType,
    type SandboxBrewRun,
    type SandboxDemoTank,
} from "../../SERVICES/brewing/brewingSandbox";
import {
    createSandboxBrewSheet,
    deleteSandboxBrewSheet,
    ensureSandboxSheetAccess,
} from "../../SERVICES/brewing/sandboxSheet";
import BrewingLibrary from "./BrewingLibrary";
import CreateBrewModal from "./CreateBrewModal";
import BrewFormStepper from "./BrewFormStepper";
import BeerLoader from "../general/Loading";
import "./BrewingView.css";
import type { BrewingTab } from "./brewingTabs";
import { beerStyleClass } from "../../SERVICES/cooler/Pallettypes ";

type Props = {
    brews: Fermentor[];
    tab: BrewingTab;
};

function tankTypeKey(
    tankNumber: unknown,
    style = "",
): "single" | "double" | "triple" {
    const tank = Number(tankNumber);
    if (Number.isFinite(tank) && tank > 0) {
        if (tank < 5) return "single";
        if (tank < 9) return "double";
        return "triple";
    }

    if (/משולש/.test(style)) return "triple";
    if (/כפול/.test(style)) return "double";
    return "single";
}

function extractSpreadsheetId(value: unknown): string {
    const text = String(value || "").trim();
    if (!text) return "";
    const match = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : text;
}

function productionRunFromTank(tank: Fermentor): SandboxBrewRun | null {
    const batchNumber = String(tank.batchNumber || "").replace("#", "").trim();
    const style = String(tank.beerStyle || "").trim();
    const sheetUrl = String(tank.sheetUrl || "").trim();
    const sheetId = extractSpreadsheetId(sheetUrl);

    if (!batchNumber || !style || !sheetId) return null;

    return {
        batchNumber,
        tankId: tank.id,
        tankNumber: String(tank.tankNumber ?? tank.id),
        tankType: tankTypeKey(tank.tankNumber, style),
        style,
        brewDate: String(tank.brewDate || ""),
        createdAt: new Date(0).toISOString(),
        source: "production",
        started: Number(tank.action) !== 0,
        sheetId,
        sheetUrl,
        sheetName: "",
        assignmentStatus: "assigned",
    };
}

function productionRunFromSummary(
    row: BrewingDriveHistoryRow,
): SandboxBrewRun | null {
    const batchNumber = String(row.batchNumber || "").replace("#", "").trim();
    const style = String(row.beerStyle || "").trim();
    const sheetUrl = String(row.sheetUrl || "").trim();
    const sheetId = extractSpreadsheetId(sheetUrl);

    if (!batchNumber || !style || !sheetId) return null;

    return {
        batchNumber,
        tankId: `history-${batchNumber}`,
        tankNumber: String(row.tankNumber || "—"),
        tankType: row.tankType || tankTypeKey(row.tankNumber, style),
        style,
        brewDate: String(row.brewDate || ""),
        createdAt: new Date(0).toISOString(),
        source: "production",
        started: true,
        sheetId,
        sheetUrl,
        sheetName: "",
        assignmentStatus: "assigned",
    };
}

function productionTankStatus(tank: Fermentor): string {
    const stageName = String(tank.brewProgress?.stageName || "").trim();
    if (stageName) return stageName;

    const action = Number(tank.action);
    const labels: Record<number, string> = {
        0: "בישול חדש",
        1: "בתסיסה",
        3: "מלוכלך / ריק",
        4: "נקי",
        5: "מחוטא",
    };
    return labels[action] || `ACTION ${String(tank.action ?? "—")}`;
}

export default function BrewingView({ brews, tab }: Props) {
    const sandbox = isBrewingSandbox();
    const [sandboxRuns, setSandboxRuns] = useState<SandboxBrewRun[]>(() => loadSandboxBrewRuns());
    const [recipes, setRecipes] = useState<BrewRecipe[]>(() => loadSandboxRecipes());
    const [busyTankId, setBusyTankId] = useState<string | null>(null);
    const [message, setMessage] = useState<string>("");
    const [suggestedBatch, setSuggestedBatch] = useState<string>("");
    const [demoTank, setDemoTank] = useState<SandboxDemoTank>(() => loadSandboxDemoTank());
    const [selectedRun, setSelectedRun] = useState<SandboxBrewRun | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [planningHints, setPlanningHints] = useState<PlannedBrewHint[]>([]);
    const [planningHintsAvailable, setPlanningHintsAvailable] = useState(false);
    const [planningHintsLoading, setPlanningHintsLoading] = useState(false);
    const [createModalError, setCreateModalError] = useState("");
    const [deletingBatch, setDeletingBatch] = useState<string | null>(null);
    const [productionHistory, setProductionHistory] =
        useState<BrewingDriveHistoryRow[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyQuery, setHistoryQuery] = useState("");

    const demoTankAsFermentor = useMemo<Fermentor>(
        () => ({
            id: demoTank.id,
            uid: demoTank.id,
            tankNumber: demoTank.tankNumber,
            action: demoTank.action,
            stage: { name: demoTank.stageName } as Fermentor["stage"],
        }),
        [demoTank]
    );

    const allTanks = useMemo(() => {
        const production = brews
            .filter((tank) => Number(tank.tankNumber) !== 1)
            .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber));

        if (!sandbox) return production;
        return [...production, demoTankAsFermentor].sort(
            (a, b) => Number(a.tankNumber) - Number(b.tankNumber)
        );
    }, [brews, demoTankAsFermentor, sandbox]);

    const editableProductionTanks = useMemo(
        () =>
            brews
                .filter((tank) => Number(tank.tankNumber) !== 1)
                .filter((tank) => !!productionRunFromTank(tank))
                .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews],
    );

    const actionZeroProductionTanks = useMemo(
        () =>
            brews
                .filter(
                    (tank) =>
                        Number(tank.tankNumber) !== 1 &&
                        Number(tank.action) === 0,
                )
                .sort(
                    (a, b) =>
                        Number(a.tankNumber) - Number(b.tankNumber),
                ),
        [brews],
    );

    const invalidActionZeroTanks = useMemo(
        () =>
            actionZeroProductionTanks.filter(
                (tank) => !productionRunFromTank(tank),
            ),
        [actionZeroProductionTanks],
    );

    const otherProductionTanks = useMemo(
        () =>
            editableProductionTanks.filter(
                (tank) => Number(tank.action) !== 0,
            ),
        [editableProductionTanks],
    );

    const selectedRecipe = useMemo(() => {
        if (!selectedRun) return null;
        if (selectedRun.recipeSnapshot) return selectedRun.recipeSnapshot;

        const matching =
            recipes.find((item) => sameStyle(item.style, selectedRun.style)) ||
            recipes.find(
                (item) =>
                    item.id.toLowerCase() ===
                    selectedRun.style.trim().toLowerCase(),
            );

        if (matching) return matching;
        return selectedRun.source === "production" ? null : recipes[0] || null;
    }, [recipes, selectedRun]);

    const currentProductionBatchNumbers = useMemo(
        () =>
            new Set(
                editableProductionTanks
                    .map((tank) =>
                        String(tank.batchNumber || "").replace("#", "").trim(),
                    )
                    .filter(Boolean),
            ),
        [editableProductionTanks],
    );

    const historicalProductionRuns = useMemo(() => {
        const query = historyQuery.trim().toLowerCase();

        return productionHistory
            .map(productionRunFromSummary)
            .filter((run): run is SandboxBrewRun => !!run)
            .filter((run) => !currentProductionBatchNumbers.has(run.batchNumber))
            .filter((run) => {
                if (!query) return true;
                return [
                    run.batchNumber,
                    run.style,
                    run.tankNumber,
                    run.brewDate || "",
                ].some((value) => String(value).toLowerCase().includes(query));
            })
            .slice(0, query ? 30 : 12);
    }, [productionHistory, currentProductionBatchNumbers, historyQuery]);

    useEffect(() => {
        if (!sandbox) return;
        let changed = false;
        sandboxRuns.forEach((run) => {
            if (run.recipeSnapshot) return;
            const source =
                recipes.find((recipe) => recipe.style === run.style) ||
                recipes.find((recipe) => recipe.id === "ipa");
            if (!source) return;
            attachSandboxRecipeSnapshot(run.batchNumber, source);
            changed = true;
        });
        if (changed) setSandboxRuns(loadSandboxBrewRuns());
        // Existing demo batches get a one-time snapshot.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sandbox]);

    useEffect(() => {
        if (!sandbox) return;

        let changed = false;

        allTanks.forEach((tank) => {
            if (Number(tank.action) !== 5) return;

            const tankNumber = String(tank.tankNumber ?? tank.id);
            const hasAssignedSandboxRun = sandboxRuns.some(
                (run) =>
                    String(run.tankNumber) === tankNumber &&
                    (run.assignmentStatus || "assigned") === "assigned" &&
                    !run.started,
            );
            if (hasAssignedSandboxRun) return;

            const assigned = assignNextSandboxRunToTank(tankNumber);
            if (!assigned) return;

            changed = true;

            if (tank.id === demoTank.id) {
                setDemoTank(markSandboxDemoTankBrewing());
            }
        });

        if (changed) {
            setSandboxRuns(loadSandboxBrewRuns());
        }
    }, [sandbox, allTanks, sandboxRuns, demoTank.id]);

    useEffect(() => {
        let cancelled = false;
        setHistoryLoading(true);
        serverListBrewDriveHistory(100)
            .then((rows) => {
                if (cancelled) return;
                setProductionHistory(rows);
                const maxHistory = rows.reduce((current, row) => {
                    const value = Number(String(row.batchNumber).replace("#", "").trim());
                    return Number.isFinite(value) ? Math.max(current, value) : current;
                }, 0);
                const maxAssigned = brews.reduce((current, tank) => {
                    const value = Number(String(tank.batchNumber || "").replace("#", "").trim());
                    return Number.isFinite(value) ? Math.max(current, value) : current;
                }, 0);
                const max = Math.max(maxHistory, maxAssigned);
                if (max > 0) {
                    const sandboxUsed = new Set(
                        sandboxRuns.map((run) => Number(run.batchNumber)),
                    );
                    let candidate = max + 1;
                    while (sandboxUsed.has(candidate)) candidate += 1;
                    setSuggestedBatch(String(candidate));
                }
            })
            .catch(() => {
                if (!cancelled) setProductionHistory([]);
            })
            .finally(() => {
                if (!cancelled) setHistoryLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [brews, sandboxRuns]);

    useEffect(() => {
        if (!sandbox || !showCreate) return;

        let cancelled = false;
        setPlanningHintsLoading(true);
        getCurrentWeekPlannedBrewHints().then((result) => {
            if (cancelled) return;
            const weekEnd = addDays(result.weekId, 6);
            const reconciled = result.hints.map((hint) => {
                const source = brews.find((tank) => tank.id === hint.tankId);
                if (!source?.batchNumber || !source.beerStyle) return hint;

                const brewed = parseDate(source.brewDate);
                const belongsToWeek =
                    Number(source.action) === 0 ||
                    (!!brewed &&
                        brewed >= result.weekId &&
                        brewed <= weekEnd);

                if (
                    belongsToWeek &&
                    sameStyle(source.beerStyle, hint.style)
                ) {
                    return {
                        ...hint,
                        batchNumber: String(source.batchNumber),
                    };
                }

                return hint;
            });
            setPlanningHints(reconciled);
            setPlanningHintsAvailable(result.available);
        }).finally(() => {
            if (!cancelled) setPlanningHintsLoading(false);
        });

        return () => {
            cancelled = true;
        };
    }, [sandbox, showCreate, brews]);

    useEffect(() => {
        if (!sandbox || !showCreate || planningHints.length === 0) return;

        const used = new Set(
            [
                ...brews.map((tank) => String(tank.batchNumber || "").replace("#", "").trim()),
                ...sandboxRuns.map((run) => String(run.batchNumber).replace("#", "").trim()),
            ].filter(Boolean),
        );

        const nextPlanned = [...planningHints]
            .filter((hint) => !used.has(String(hint.batchNumber).replace("#", "").trim()))
            .sort((a, b) => Number(a.batchNumber) - Number(b.batchNumber))[0];

        if (nextPlanned?.batchNumber) {
            setSuggestedBatch(String(nextPlanned.batchNumber));
        }
    }, [sandbox, showCreate, planningHints, brews, sandboxRuns]);

    function findProductionAssignment(batchNumber: string): Fermentor | null {
        const clean = String(batchNumber || "").replace("#", "").trim();
        if (!clean) return null;
        return (
            brews.find(
                (tank) =>
                    String(tank.batchNumber || "").replace("#", "").trim() === clean,
            ) || null
        );
    }

    async function createSandbox(
        tank: Fermentor,
        draft: { batchNumber: string; style: string },
    ) {
        const productionAssignment = findProductionAssignment(draft.batchNumber);
        if (productionAssignment) {
            const assignedTank = String(
                productionAssignment.tankNumber ?? productionAssignment.id,
            );
            const isUnstarted = Number(productionAssignment.action) === 0;
            setCreateModalError(
                isUnstarted
                    ? `אצווה ${draft.batchNumber} כבר משויכת למיכל ${assignedTank} ועדיין לא התחילה. לא תיווצר אצווה נוספת — הפעולה הנכונה תהיה העברת שיוך/החלפה.`
                    : `אצווה ${draft.batchNumber} כבר קיימת במיכל ${assignedTank} ולכן לא ניתן ליצור אותה שוב.`,
            );
            return;
        }

        if (sandbox && draft.style !== "IPA") {
            setCreateModalError(
                "בשלב ה-Sandbox הראשון יצירת Sheet פעילה ל-IPA בלבד.",
            );
            return;
        }

        const recipe =
            recipes.find((item) => item.style === draft.style) ||
            recipes.find((item) => item.id === "ipa");
        if (!recipe) {
            setCreateModalError("לא נמצא מתכון לסגנון שנבחר.");
            return;
        }

        const isSanitized = Number(tank.action) === 5;
        setMessage("");
        setCreateModalError("");
        setBusyTankId(tank.id);
        let createdBatch: string | null = null;

        try {
            const run = await createSandboxBrewRun({
                batchNumber: draft.batchNumber,
                tankId: tank.id,
                tankNumber: String(tank.tankNumber ?? tank.id),
                tankType:
                    tank.id === demoTank.id
                        ? demoTank.tankType
                        : tankTypeKey(tank.tankNumber),
                style: draft.style,
                source: "manual",
                recipeSnapshot: recipe,
                assignmentStatus: isSanitized ? "assigned" : "pending_sanitization",
            });
            createdBatch = run.batchNumber;

            await ensureSandboxSheetAccess();

            const sheet = await createSandboxBrewSheet({
                batchNumber: run.batchNumber,
                style: run.style,
                tankNumber: run.tankNumber,
                tankType: run.tankType,
                recipe,
                ingredients: loadSandboxIngredients(),
            });

            attachSandboxSheet(run.batchNumber, sheet);
            setSandboxRuns(loadSandboxBrewRuns());

            if (tank.id === demoTank.id && isSanitized) {
                setDemoTank(markSandboxDemoTankBrewing());
            }

            setMessage(
                isSanitized
                    ? `✓ אצווה ${run.batchNumber} נוצרה ושויכה למיכל ${run.tankNumber} ב-Sandbox.`
                    : `✓ אצווה ${run.batchNumber} נוצרה. היא ממתינה לשיבוץ למיכל ${run.tankNumber} עד שהמיכל יהיה מחוטא.`,
            );
            setSuggestedBatch(String(Number(run.batchNumber) + 1));
            setShowCreate(false);
            setCreateModalError("");
        } catch (error) {
            if (createdBatch) {
                deleteSandboxBrewRun(createdBatch);
                setSandboxRuns(loadSandboxBrewRuns());
            }
            setCreateModalError(
                error instanceof Error
                    ? error.message
                    : "יצירת אצוות Sandbox וה-Sheet נכשלה.",
            );
        } finally {
            setBusyTankId(null);
        }
    }

    async function removeSandboxRun(run: SandboxBrewRun) {
        setMessage("");
        setDeletingBatch(run.batchNumber);
        try {
            if (run.sheetId) {
                await ensureSandboxSheetAccess();
                await deleteSandboxBrewSheet(run.sheetId);
            }
            deleteSandboxBrewRun(run.batchNumber);
            setSandboxRuns(loadSandboxBrewRuns());
            setMessage(`אצוות Sandbox ${run.batchNumber} וה-Sheet שלה נמחקו.`);
        } catch (error) {
            setMessage(
                error instanceof Error
                    ? error.message
                    : "מחיקת אצוות ה-Sandbox נכשלה.",
            );
        } finally {
            setDeletingBatch(null);
        }
    }

    function resetDemoAndAssignQueue() {
        setDemoTank(resetSandboxDemoTank());
        const assigned = assignNextSandboxRunToTank("20");
        if (assigned) {
            setSandboxRuns(loadSandboxBrewRuns());
            setDemoTank(markSandboxDemoTankBrewing());
            setMessage(
                `מיכל דמו 20 חזר למחוטא ואצווה ${assigned.batchNumber} שובצה אליו אוטומטית מהתור.`,
            );
        } else {
            setMessage("מיכל דמו 20 הוחזר למצב מחוטא.");
        }
    }

    return (
        <main className="brewing-view" dir="rtl">
            {tab === "form" && !selectedRun && actionZeroProductionTanks.length > 0 && (
                <section className="brewing-action-zero-strip" aria-label="מיכלים ב-ACTION 0">
                    <div className="brewing-action-zero-heading">
                        <strong>מיכלים „בישול חדש”</strong>
                        <span>נתוני אמת</span>
                    </div>
                    <div className="brewing-action-zero-list">
                        {actionZeroProductionTanks.map((tank) => {
                            const run = productionRunFromTank(tank);
                            const rawStyle = String(tank.beerStyle || "");
                            const style = beerStyleClass(rawStyle);
                            const recipe =
                                run
                                    ? recipes.find((item) =>
                                          sameStyle(item.style, run.style),
                                      ) || null
                                    : null;

                            return (
                                <button
                                    type="button"
                                    className="brewing-action-zero-chip"
                                    key={tank.id}
                                    disabled={!sandbox || !run || !recipe}
                                    onClick={() => {
                                        if (!run) return;
                                        setMessage("");
                                        setSelectedRun(run);
                                    }}
                                >
                                    <strong>
                                        מיכל {String(tank.tankNumber ?? tank.id)}
                                    </strong>
                                    <span>
                                        {tank.batchNumber
                                            ? `#${String(tank.batchNumber)}`
                                            : "ללא אצווה"}
                                    </span>
                                    <span
                                        className={`brewing-style-tag ${style.className}`}
                                    >
                                        {style.displayLabel || "—"}
                                    </span>
                                    <small>
                                        {run
                                            ? tank.brewProgress?.stageName || "בישול חדש"
                                            : "חריגת נתונים · בישול חדש ללא Sheet"}
                                    </small>
                                </button>
                            );
                        })}
                    </div>
                </section>
            )}

            {tab === "form" && !selectedRun && invalidActionZeroTanks.length > 0 && (
                <div className="brewing-message brewing-message-error">
                    נמצאו {invalidActionZeroTanks.length} מיכלים במצב „בישול חדש”
                    ללא Sheet משויך. זה מצב לא תקין לפי מנגנון ACTION 5 ויש לבדוק
                    את נתוני המיכל / המעבר האחרון.
                </div>
            )}

            {sandbox && (
                <div className="brewing-preview-note" role="status">
                    PR Preview · עריכת אצוות אמת פעילה. יצירת אצווה חדשה עדיין משתמשת
                    ב-Sandbox עד שנעביר גם את פעולת היצירה לנתוני אמת.
                </div>
            )}

            {message && <div className="brewing-message">{message}</div>}

            {tab === "form" && sandbox && !selectedRun && (
                <CreateBrewModal
                    open={showCreate}
                    tanks={allTanks}
                    recipes={recipes}
                    suggestedBatch={suggestedBatch}
                    sandboxRuns={sandboxRuns}
                    demoTank={demoTank}
                    busyTankId={busyTankId}
                    planningHints={planningHints}
                    planningHintsAvailable={planningHintsAvailable}
                    planningHintsLoading={planningHintsLoading}
                    error={createModalError}
                    onClearError={() => setCreateModalError("")}
                    onClose={() => {
                        setCreateModalError("");
                        setShowCreate(false);
                    }}
                    onDemoTankTypeChange={(value) =>
                        setDemoTank(setSandboxDemoTankType(value))
                    }
                    onCreate={createSandbox}
                />
            )}

            {tab === "recipes" && (
                <section className="brewing-panel">
                    {sandbox ? (
                        <BrewingLibrary
                            onRecipesChange={(next) => {
                                setRecipes(next);
                            }}
                        />
                    ) : (
                        <>
                            <h2>מתכונים וחומרי גלם</h2>
                            <p>הספריות יתחברו ל-Firestore לפני העלאה לפרודקשן.</p>
                        </>
                    )}
                </section>
            )}

            {tab === "form" && selectedRun && sandbox && selectedRecipe && (
                <BrewFormStepper
                    run={selectedRun}
                    recipe={selectedRecipe}
                    onClose={() => setSelectedRun(null)}
                />
            )}

            {tab === "form" && !selectedRun && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>אצוות בישול</h2>
                            <p>
                                אצוות Sandbox לצד אצוות אמת. באצוות אמת העריכה מעדכנת
                                את ה-Sheet המקורי בלבד ואינה משנה ACTION / Stage.
                            </p>
                        </div>
                        <div className="brewing-heading-actions">
                            <span className="brewing-count">
                                {sandboxRuns.length + editableProductionTanks.length}
                            </span>
                            {sandbox && (
                                <button
                                    type="button"
                                    className="btn-primary brewing-create-button"
                                    onClick={() => {
                                        setCreateModalError("");
                                        setShowCreate(true);
                                    }}
                                >
                                    + יצירת בישול חדש
                                </button>
                            )}
                        </div>
                    </div>

                    {sandbox && (
                        <div className="brewing-demo-controls">
                            <div>
                                <strong>מיכל דמו 20</strong>
                                <span>
                                    {demoTank.stageName} ·{" "}
                                    {demoTank.tankType === "single"
                                        ? "בודד"
                                        : demoTank.tankType === "double"
                                            ? "כפול"
                                            : "משולש"}
                                </span>
                            </div>
                            <button type="button" onClick={resetDemoAndAssignQueue}>
                                החזר למחוטא
                            </button>
                        </div>
                    )}

                    {sandbox && sandboxRuns.length > 0 && (
                        <>
                            <h3 className="brewing-subheading">אצוות Sandbox</h3>
                            <div className="brewing-tank-grid">
                                {sandboxRuns.map((run) => {
                                    const pending =
                                        (run.assignmentStatus || "assigned") ===
                                        "pending_sanitization";
                                    return (
                                        <article
                                            className="brewing-tank-card brewing-sandbox-card"
                                            key={run.batchNumber}
                                        >
                                            <div className="brewing-tank-card-top">
                                                <strong>אצווה {run.batchNumber}</strong>
                                                {(() => {
                                                    const style = beerStyleClass(run.style);
                                                    return (
                                                        <span
                                                            className={`brewing-style-tag ${style.className}`}
                                                        >
                                                            {style.displayLabel}
                                                        </span>
                                                    );
                                                })()}
                                            </div>
                                            <div className="brewing-tank-meta">
                                                <span>מיכל יעד {run.tankNumber}</span>
                                                <span>
                                                    {pending
                                                        ? "ממתינה לשיבוץ — המיכל אינו מחוטא"
                                                        : "משויכת למיכל · עדיין לא בבישול"}
                                                </span>
                                                <span>Sandbox בלבד</span>
                                            </div>
                                            <div className="brewing-card-actions">
                                                {run.sheetUrl ? (
                                                    <a
                                                        className="brewing-sheet-link"
                                                        href={run.sheetUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        פתח Sheet
                                                    </a>
                                                ) : (
                                                    <button type="button" disabled>
                                                        Sheet לא נוצר
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={
                                                        pending ||
                                                        !run.sheetId
                                                    }
                                                    onClick={() => {
                                                        setMessage("");
                                                        setSelectedRun(run);
                                                    }}
                                                >
                                                    {pending
                                                        ? "ממתינה למיכל מחוטא"
                                                        : "מילוי טופס בישול"}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="brewing-danger-button"
                                                    disabled={deletingBatch === run.batchNumber}
                                                    onClick={() => void removeSandboxRun(run)}
                                                >
                                                    {deletingBatch === run.batchNumber ? (
                                                        <BeerLoader size="spinner" message="מוחק…" />
                                                    ) : (
                                                        "מחק"
                                                    )}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    {otherProductionTanks.length > 0 && (
                        <>
                            <h3 className="brewing-subheading">
                                אצוות אמת — ACTION 1/3/4/5
                            </h3>
                            <div className="brewing-real-data-note">
                                <strong>זה מידע אמיתי.</strong>
                                <span>
                                    פתיחת אצווה מושכת את הנתונים מה-Sheet הקיים.
                                    כל שמירה בטופס נכתבת חזרה לאותו Sheet.
                                </span>
                            </div>
                            <div className="brewing-tank-grid">
                                {otherProductionTanks.map((tank) => {
                                    const run = productionRunFromTank(tank);
                                    if (!run) return null;
                                    const style = beerStyleClass(run.style);
                                    const recipe =
                                        recipes.find((item) =>
                                            sameStyle(item.style, run.style),
                                        ) || null;

                                    return (
                                        <article
                                            className="brewing-tank-card brewing-production-card"
                                            key={tank.id}
                                        >
                                            <div className="brewing-tank-card-top">
                                                <strong>אצווה {run.batchNumber}</strong>
                                                <span
                                                    className={`brewing-style-tag ${style.className}`}
                                                >
                                                    {style.displayLabel}
                                                </span>
                                            </div>
                                            <div className="brewing-tank-meta">
                                                <span>מיכל {run.tankNumber}</span>
                                                <span>{productionTankStatus(tank)}</span>
                                                <span>ACTION {String(tank.action ?? "—")}</span>
                                            </div>
                                            <div className="brewing-card-actions">
                                                <a
                                                    className="brewing-sheet-link"
                                                    href={run.sheetUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    פתח Sheet
                                                </a>
                                                <button
                                                    type="button"
                                                    disabled={!sandbox || !recipe}
                                                    onClick={() => {
                                                        setMessage("");
                                                        setSelectedRun(run);
                                                    }}
                                                >
                                                    {!recipe
                                                        ? "חסר מתכון תואם"
                                                        : sandbox
                                                          ? "עריכת נתוני בישול"
                                                          : "עריכה זמינה ב-Preview"}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    <div className="brewing-history-section">
                        <div className="brewing-history-heading">
                            <div>
                                <h3 className="brewing-subheading">
                                    אצוות קודמות לעריכה
                                </h3>
                                <small>
                                    חיפוש מתוך 100 האצוות האחרונות ב-Drive
                                </small>
                            </div>
                            <input
                                type="search"
                                value={historyQuery}
                                placeholder="אצווה / סגנון / מיכל / תאריך"
                                onChange={(event) =>
                                    setHistoryQuery(event.target.value)
                                }
                            />
                        </div>

                        {historyLoading ? (
                            <div className="brewing-history-loader">
                                <BeerLoader size="small" message="טוען אצוות…" />
                            </div>
                        ) : historicalProductionRuns.length > 0 ? (
                            <div className="brewing-tank-grid">
                                {historicalProductionRuns.map((run) => {
                                    const style = beerStyleClass(run.style);
                                    const recipe =
                                        recipes.find((item) =>
                                            sameStyle(item.style, run.style),
                                        ) || null;

                                    return (
                                        <article
                                            className="brewing-tank-card brewing-history-card"
                                            key={`history-${run.batchNumber}`}
                                        >
                                            <div className="brewing-tank-card-top">
                                                <strong>אצווה {run.batchNumber}</strong>
                                                <span
                                                    className={`brewing-style-tag ${style.className}`}
                                                >
                                                    {style.displayLabel}
                                                </span>
                                            </div>
                                            <div className="brewing-tank-meta">
                                                <span>
                                                    {run.tankNumber === "—"
                                                        ? "מיכל לא ידוע"
                                                        : `מיכל ${run.tankNumber}`}
                                                </span>
                                                <span>{run.brewDate || "ללא תאריך"}</span>
                                            </div>
                                            <div className="brewing-card-actions">
                                                <a
                                                    className="brewing-sheet-link"
                                                    href={run.sheetUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    פתח Sheet
                                                </a>
                                                <button
                                                    type="button"
                                                    disabled={!sandbox || !recipe}
                                                    onClick={() => {
                                                        setMessage("");
                                                        setSelectedRun(run);
                                                    }}
                                                >
                                                    {!recipe
                                                        ? "חסר מתכון תואם"
                                                        : "עריכת נתוני בישול"}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="brewing-empty">
                                {historyQuery
                                    ? "לא נמצאה אצווה תואמת עם Sheet לעריכה."
                                    : "לא נמצאו אצוות קודמות עם Sheet זמין לעריכה."}
                            </div>
                        )}
                    </div>

                    {sandboxRuns.length === 0 &&
                        editableProductionTanks.length === 0 &&
                        productionHistory.length === 0 && (
                            <div className="brewing-empty">
                                אין כרגע אצוות להצגה.
                            </div>
                        )}
                </section>
            )}
        </main>
    );
}
