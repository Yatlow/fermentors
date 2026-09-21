import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { getAllBrewsSummary } from "../../SERVICES/getAndPost/getAllBrews";
import {
    loadSandboxRecipes,
    type BrewRecipe,
} from "../../SERVICES/brewing/sandboxRecipe";
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
import BrewFormStepper from "./BrewFormStepper";
import "./BrewingView.css";
import type { BrewingTab } from "./brewingTabs";

type Props = {
    brews: Fermentor[];
    tab: BrewingTab;
};

type Draft = {
    batchNumber: string;
    style: string;
};

const DEFAULT_STYLES = ["IPA", "פייל", "חיטה", "לאגר", "הופי לאגר", "סטאוט"];

function tankType(tankNumber: unknown): "בודד" | "כפול" | "משולש" {
    const tank = Number(tankNumber);
    if (tank < 5) return "בודד";
    if (tank < 9) return "כפול";
    return "משולש";
}

function tankTypeKey(tankNumber: unknown): "single" | "double" | "triple" {
    const tank = Number(tankNumber);
    if (tank < 5) return "single";
    if (tank < 9) return "double";
    return "triple";
}

function tankStatusLabel(tank: Fermentor): string {
    if (Number(tank.action) === 5) return "מחוטא";
    if (Number(tank.action) === 0) return "בישול חדש";
    return String(tank.stage?.name || "לא מחוטא");
}

export default function BrewingView({ brews, tab }: Props) {
    const sandbox = isBrewingSandbox();
    const [sandboxRuns, setSandboxRuns] = useState<SandboxBrewRun[]>(() => loadSandboxBrewRuns());
    const [recipes, setRecipes] = useState<BrewRecipe[]>(() => loadSandboxRecipes());
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [busyTankId, setBusyTankId] = useState<string | null>(null);
    const [message, setMessage] = useState<string>("");
    const [suggestedBatch, setSuggestedBatch] = useState<string>("");
    const [demoTank, setDemoTank] = useState<SandboxDemoTank>(() => loadSandboxDemoTank());
    const [selectedRun, setSelectedRun] = useState<SandboxBrewRun | null>(null);
    const [openingBatch, setOpeningBatch] = useState<string | null>(null);

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

    const styles = useMemo(() => {
        if (sandbox) {
            const names = recipes.map((recipe) => recipe.style).filter(Boolean);
            return names.length ? names : ["IPA"];
        }
        const fromTanks = brews
            .map((tank) => String(tank.beerStyle || "").trim())
            .filter(Boolean);
        return Array.from(new Set([...DEFAULT_STYLES, ...fromTanks])).sort((a, b) =>
            a.localeCompare(b, "he")
        );
    }, [brews, recipes, sandbox]);

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
                const maxSandbox = sandboxRuns.reduce((current, run) => {
                    const value = Number(run.batchNumber);
                    return Number.isFinite(value) ? Math.max(current, value) : current;
                }, 0);
                const max = Math.max(maxHistory, maxAssigned, maxSandbox);
                if (max > 0) setSuggestedBatch(String(max + 1));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [sandbox, brews, sandboxRuns]);

    useEffect(() => {
        if (!sandbox || !suggestedBatch) return;
        setDrafts((current) => {
            const next = { ...current };
            allTanks.forEach((tank, index) => {
                if (next[tank.id]) return;
                next[tank.id] = {
                    batchNumber: String(Number(suggestedBatch) + index),
                    style: styles[0] || "IPA",
                };
            });
            return next;
        });
    }, [sandbox, allTanks, styles, suggestedBatch]);

    function updateDraft(tankId: string, patch: Partial<Draft>) {
        setDrafts((current) => ({
            ...current,
            [tankId]: {
                batchNumber: current[tankId]?.batchNumber || suggestedBatch,
                style: current[tankId]?.style || styles[0] || "IPA",
                ...patch,
            },
        }));
    }

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

    function queueForTank(tank: Fermentor) {
        const number = String(tank.tankNumber ?? tank.id);
        return sandboxRuns
            .filter(
                (run) =>
                    String(run.tankNumber) === number &&
                    (run.assignmentStatus || "assigned") === "pending_sanitization",
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async function createSandbox(tank: Fermentor) {
        const draft = drafts[tank.id] || {
            batchNumber: suggestedBatch,
            style: styles[0] || "IPA",
        };
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

            {tab === "create" && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>יצירת בישול לפי מיכל יעד</h2>
                            <p>
                                אפשר ליצור אצווה לכל מיכל. מיכל שאינו מחוטא יקבל את האצווה לתור והיא לא תשויך בפועל עד החיטוי.
                            </p>
                        </div>
                        <span className="brewing-count">{allTanks.length}</span>
                    </div>

                    <div className="brewing-tank-grid">
                        {allTanks.map((tank) => {
                            const draft = drafts[tank.id] || {
                                batchNumber: suggestedBatch,
                                style: styles[0] || "IPA",
                            };
                            const productionAssignment =
                                findProductionAssignment(draft.batchNumber);
                            const reassignmentPossible =
                                productionAssignment &&
                                Number(productionAssignment.action) === 0;
                            const isSanitized = Number(tank.action) === 5;
                            const queued = queueForTank(tank);
                            const isDemo = tank.id === demoTank.id;

                            return (
                                <article
                                    className={`brewing-tank-card ${!isSanitized ? "brewing-tank-card-waiting" : ""}`}
                                    key={tank.id}
                                >
                                    <div className="brewing-tank-card-top">
                                        <strong>מיכל {String(tank.tankNumber ?? tank.id)}</strong>
                                        <span>
                                            {isDemo
                                                ? demoTank.tankType === "single"
                                                    ? "בודד"
                                                    : demoTank.tankType === "double"
                                                        ? "כפול"
                                                        : "משולש"
                                                : tankType(tank.tankNumber)}
                                        </span>
                                    </div>

                                    <div className="brewing-tank-meta">
                                        <span>
                                            סטטוס: <strong>{tankStatusLabel(tank)}</strong>
                                        </span>
                                        {isDemo && <span>מיכל פיקטיבי ל-Sandbox בלבד</span>}
                                        {tank.batchNumber && (
                                            <span>אצווה נוכחית: {String(tank.batchNumber)}</span>
                                        )}
                                    </div>

                                    {queued.length > 0 && (
                                        <div className="brewing-tank-queue">
                                            <strong>בתור למיכל ({queued.length})</strong>
                                            {queued.map((run, index) => (
                                                <span key={run.batchNumber}>
                                                    {index + 1}. #{run.batchNumber} · {run.style}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {!isSanitized && (
                                        <div className="brewing-assignment-warning">
                                            האצווה תיווצר עכשיו, אבל תישאר ממתינה לשיבוץ עד שהמיכל יהיה מחוטא.
                                        </div>
                                    )}

                                    {sandbox ? (
                                        <div className="brewing-create-fields">
                                            {isDemo && (
                                                <label>
                                                    גודל מיכל דמו
                                                    <select
                                                        value={demoTank.tankType}
                                                        onChange={(event) =>
                                                            setDemoTank(
                                                                setSandboxDemoTankType(
                                                                    event.target.value as SandboxDemoTank["tankType"],
                                                                ),
                                                            )
                                                        }
                                                    >
                                                        <option value="single">בודד</option>
                                                        <option value="double">כפול</option>
                                                        <option value="triple">משולש</option>
                                                    </select>
                                                </label>
                                            )}
                                            <label>
                                                אצווה
                                                <input
                                                    inputMode="numeric"
                                                    value={draft.batchNumber}
                                                    onChange={(event) =>
                                                        updateDraft(tank.id, {
                                                            batchNumber: event.target.value.replace(/\D/g, ""),
                                                        })
                                                    }
                                                />
                                            </label>
                                            <label>
                                                מתכון
                                                <select
                                                    value={draft.style}
                                                    onChange={(event) =>
                                                        updateDraft(tank.id, { style: event.target.value })
                                                    }
                                                >
                                                    {styles.map((style) => (
                                                        <option key={style} value={style}>
                                                            {style}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>

                                            {productionAssignment ? (
                                                <div className="brewing-batch-conflict">
                                                    <strong>
                                                        אצווה {draft.batchNumber} כבר במיכל{" "}
                                                        {String(
                                                            productionAssignment.tankNumber ??
                                                                productionAssignment.id,
                                                        )}
                                                    </strong>
                                                    <span>
                                                        {reassignmentPossible
                                                            ? "האצווה עדיין לפני בישול. בפרודקשן נציע העברה/החלפה במקום ליצור כפילות."
                                                            : "האצווה כבר פעילה ולכן אי אפשר ליצור אותה שוב."}
                                                    </span>
                                                </div>
                                            ) : draft.style !== "IPA" ? (
                                                <small className="brewing-field-note">
                                                    ספריית המתכונים כבר תומכת במתכונים נוספים; יצירת Sheet ב-Sandbox מחוברת כרגע ל-IPA בלבד.
                                                </small>
                                            ) : null}

                                            <button
                                                type="button"
                                                onClick={() => void createSandbox(tank)}
                                                disabled={
                                                    busyTankId === tank.id ||
                                                    !draft.batchNumber ||
                                                    !draft.style ||
                                                    Boolean(productionAssignment) ||
                                                    draft.style !== "IPA"
                                                }
                                            >
                                                {busyTankId === tank.id
                                                    ? "יוצר אצווה ו-Sheet..."
                                                    : isSanitized
                                                        ? "צור ושייך למיכל"
                                                        : "צור והכנס לתור"}
                                            </button>
                                        </div>
                                    ) : (
                                        <button type="button" disabled>
                                            יצירת בישול — בקרוב
                                        </button>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                </section>
            )}

            {tab === "recipes" && (
                <section className="brewing-panel">
                    {sandbox ? (
                        <BrewingLibrary
                            onRecipeChange={(changed) => {
                                setRecipes(loadSandboxRecipes());
                                setMessage(`המתכון ${changed.style} נשמר.`);
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
                        <span className="brewing-count">
                            {sandboxRuns.length + waitingBrews.length}
                        </span>
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
