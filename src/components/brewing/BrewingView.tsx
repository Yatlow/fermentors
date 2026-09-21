import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { getAllBrewsSummary } from "../../SERVICES/getAndPost/getAllBrews";
import { loadSandboxRecipes } from "../../SERVICES/brewing/sandboxRecipe";
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
import "./BrewingView.css";
import type { BrewingTab } from "./brewingTabs";

type Props = {
    brews: Fermentor[];
    tab: BrewingTab;
};

function tankTypeKey(tankNumber: unknown): "single" | "double" | "triple" {
    const tank = Number(tankNumber);
    if (tank < 5) return "single";
    if (tank < 9) return "double";
    return "triple";
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
    const [openingBatch, setOpeningBatch] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [planningHints, setPlanningHints] = useState<PlannedBrewHint[]>([]);
    const [planningHintsAvailable, setPlanningHintsAvailable] = useState(false);

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

    const waitingBrews = useMemo(
        () =>
            brews
                .filter((tank) => Number(tank.tankNumber) !== 1 && Number(tank.action) === 0)
                .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews]
    );

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
        if (!sandbox) return;
        let cancelled = false;
        getAllBrewsSummary()
            .then((rows) => {
                if (cancelled) return;
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
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [sandbox, brews, sandboxRuns]);

    useEffect(() => {
        if (!sandbox || !showCreate) return;

        let cancelled = false;
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
        });

        return () => {
            cancelled = true;
        };
    }, [sandbox, showCreate]);

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
            setMessage(
                isUnstarted
                    ? `אצווה ${draft.batchNumber} כבר משויכת למיכל ${assignedTank} ועדיין לא התחילה. לא תיווצר אצווה נוספת — הפעולה הנכונה תהיה העברת שיוך/החלפה.`
                    : `אצווה ${draft.batchNumber} כבר קיימת במיכל ${assignedTank} ולכן לא ניתן ליצור אותה שוב.`,
            );
            return;
        }

        const recipe =
            recipes.find((item) => item.style === draft.style) ||
            recipes.find((item) => item.id === "ipa");
        if (!recipe) {
            setMessage("לא נמצא מתכון לסגנון שנבחר.");
            return;
        }

        const isSanitized = Number(tank.action) === 5;
        setMessage("");
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
        } catch (error) {
            if (createdBatch) {
                deleteSandboxBrewRun(createdBatch);
                setSandboxRuns(loadSandboxBrewRuns());
            }
            setMessage(
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
            {sandbox && (
                <div className="brewing-sandbox-banner" role="status">
                    <strong>SANDBOX</strong>
                    <span>
                        ה-Preview מבודד: אצוות הבדיקה וסטטוסי השיבוץ כאן לא משנים מיכלים בפרודקשן.
                    </span>
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
                    onClose={() => setShowCreate(false)}
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

            {tab === "form" && selectedRun && sandbox && (
                <BrewFormStepper
                    run={selectedRun}
                    recipe={
                        selectedRun.recipeSnapshot ||
                        recipes.find((item) => item.style === selectedRun.style) ||
                        recipes[0]
                    }
                    onClose={() => setSelectedRun(null)}
                />
            )}

            {tab === "form" && !selectedRun && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>אצוות לפני / בזמן בישול</h2>
                            <p>אצוות שממתינות לחיטוי מוצגות כאן, אבל אי אפשר להתחיל להן טופס בישול לפני השיבוץ.</p>
                        </div>
                        <div className="brewing-heading-actions">
                            <span className="brewing-count">
                                {sandboxRuns.length + waitingBrews.length}
                            </span>
                            {sandbox && (
                                <button
                                    type="button"
                                    className="btn-primary brewing-create-button"
                                    onClick={() => setShowCreate(true)}
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
                                                <span>{run.style}</span>
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
                                                        !run.sheetId ||
                                                        openingBatch === run.batchNumber
                                                    }
                                                    onClick={async () => {
                                                        setOpeningBatch(run.batchNumber);
                                                        setMessage("");
                                                        try {
                                                            await ensureSandboxSheetAccess();
                                                            setSelectedRun(run);
                                                        } catch (error) {
                                                            setMessage(
                                                                error instanceof Error
                                                                    ? error.message
                                                                    : "פתיחת טופס הבישול נכשלה.",
                                                            );
                                                        } finally {
                                                            setOpeningBatch(null);
                                                        }
                                                    }}
                                                >
                                                    {pending
                                                        ? "ממתינה למיכל מחוטא"
                                                        : openingBatch === run.batchNumber
                                                            ? "מתחבר ל-Sheet..."
                                                            : "מילוי טופס בישול"}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="brewing-danger-button"
                                                    onClick={() => void removeSandboxRun(run)}
                                                >
                                                    מחק
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    {waitingBrews.length > 0 && (
                        <>
                            <h3 className="brewing-subheading">
                                אצוות פרודקשן — קריאה בלבד ב-Preview
                            </h3>
                            <div className="brewing-tank-grid">
                                {waitingBrews.map((tank) => (
                                    <article className="brewing-tank-card" key={tank.id}>
                                        <div className="brewing-tank-card-top">
                                            <strong>
                                                {tank.batchNumber
                                                    ? `אצווה ${String(tank.batchNumber)}`
                                                    : "אצווה חדשה"}
                                            </strong>
                                            <span>{String(tank.beerStyle || "")}</span>
                                        </div>
                                        <div className="brewing-tank-meta">
                                            <span>
                                                מיכל {String(tank.tankNumber ?? tank.id)}
                                            </span>
                                            <span>
                                                {tank.brewProgress?.stageName ||
                                                    "עדיין לא בבישול"}
                                            </span>
                                        </div>
                                        <button type="button" disabled>
                                            Preview — קריאה בלבד
                                        </button>
                                    </article>
                                ))}
                            </div>
                        </>
                    )}

                    {sandboxRuns.length === 0 && waitingBrews.length === 0 && (
                        <div className="brewing-empty">אין כרגע אצוות להצגה.</div>
                    )}
                </section>
            )}
        </main>
    );
}
