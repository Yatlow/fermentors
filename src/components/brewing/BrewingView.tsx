import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { getAllBrewsSummary } from "../../SERVICES/getAndPost/getAllBrews";
import { loadSandboxRecipe } from "../../SERVICES/brewing/sandboxRecipe";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import {
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
import BrewRecipeEditor from "./BrewRecipeEditor";
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

export default function BrewingView({ brews, tab }: Props) {
    const sandbox = isBrewingSandbox();
    const [sandboxRuns, setSandboxRuns] = useState<SandboxBrewRun[]>(() => loadSandboxBrewRuns());
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [busyTankId, setBusyTankId] = useState<string | null>(null);
    const [message, setMessage] = useState<string>("");
    const [suggestedBatch, setSuggestedBatch] = useState<string>("");
    const [demoTank, setDemoTank] = useState<SandboxDemoTank>(() => loadSandboxDemoTank());
    const [recipe, setRecipe] = useState<BrewRecipe>(() => loadSandboxRecipe());
    const [selectedRun, setSelectedRun] = useState<SandboxBrewRun | null>(null);
    const [openingBatch, setOpeningBatch] = useState<string | null>(null);

    const sanitizedTanks = useMemo(
        () =>
            brews
                .filter((tank) => Number(tank.tankNumber) !== 1 && Number(tank.action) === 5)
                .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews]
    );

    const demoTankAsFermentor = useMemo<Fermentor>(
        () => ({
            id: demoTank.id,
            uid: demoTank.id,
            tankNumber: demoTank.tankNumber,
            action: demoTank.action,
            stage: {
                name: demoTank.stageName,
            } as Fermentor["stage"],
        }),
        [demoTank]
    );

    const visibleSanitizedTanks = useMemo(
        () => {
            if (!sandbox) return sanitizedTanks;
            return demoTank.action === 5 ? [demoTankAsFermentor] : [];
        },
        [sandbox, demoTank.action, demoTankAsFermentor, sanitizedTanks]
    );

    const waitingBrews = useMemo(
        () =>
            brews
                .filter((tank) => Number(tank.tankNumber) !== 1 && Number(tank.action) === 0)
                .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews]
    );

    const styles = useMemo(() => {
        if (sandbox) return ["IPA"];
        const fromTanks = brews
            .map((tank) => String(tank.beerStyle || "").trim())
            .filter(Boolean);
        return Array.from(new Set([...DEFAULT_STYLES, ...fromTanks])).sort((a, b) =>
            a.localeCompare(b, "he")
        );
    }, [brews, sandbox]);

    useEffect(() => {
        if (!sandbox) return;
        let changed = false;
        sandboxRuns.forEach((run) => {
            if (run.recipeSnapshot) return;
            attachSandboxRecipeSnapshot(run.batchNumber, recipe);
            changed = true;
        });
        if (changed) setSandboxRuns(loadSandboxBrewRuns());
        // Existing Sandbox runs from before recipe snapshots get exactly one
        // snapshot when this version first sees them.
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
                    const value = Number(
                        String(tank.batchNumber || "").replace("#", "").trim(),
                    );
                    return Number.isFinite(value) ? Math.max(current, value) : current;
                }, 0);
                const max = Math.max(maxHistory, maxAssigned);
                if (max > 0) setSuggestedBatch(String(max + 1));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [sandbox, brews]);

    useEffect(() => {
        if (!sandbox || !suggestedBatch) return;
        setDrafts((current) => {
            const next = { ...current };
            visibleSanitizedTanks.forEach((tank, index) => {
                if (next[tank.id]) return;
                next[tank.id] = {
                    batchNumber: String(Number(suggestedBatch) + index),
                    style: styles[0] || "IPA",
                };
            });
            return next;
        });
    }, [sandbox, visibleSanitizedTanks, styles, suggestedBatch]);

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
                    ? `אצווה ${draft.batchNumber} כבר משויכת למיכל ${assignedTank} ועדיין לא התחילה. לא תיווצר אצווה נוספת — במסלול הפרודקשן זו תהיה פעולת העברת שיוך/החלפה.`
                    : `אצווה ${draft.batchNumber} כבר קיימת במיכל ${assignedTank} ולכן לא ניתן ליצור אותה שוב.`,
            );
            return;
        }

        setMessage("");
        setBusyTankId(tank.id);
        let createdBatch: string | null = null;

        try {
            // Finish all Firestore/local validation before opening the Google
            // permission popup. Firestore reads can fail while the main tab is
            // hidden behind an OAuth popup ("Database is closing/hidden").
            const run = await createSandboxBrewRun({
                batchNumber: draft.batchNumber,
                tankId: tank.id,
                tankNumber: String(tank.tankNumber ?? tank.id),
                tankType: tank.id === demoTank.id ? demoTank.tankType : tankTypeKey(tank.tankNumber),
                style: draft.style,
                source: "manual",
                recipeSnapshot: recipe,
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

            if (tank.id === demoTank.id) {
                setDemoTank(markSandboxDemoTankBrewing());
            }

            setMessage(
                `✓ אצווה ${run.batchNumber} ו-Sheet נוצרו ב-Sandbox. פרודקשן והמיכל האמיתי לא השתנו.`
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
                    : "יצירת אצוות Sandbox וה-Sheet נכשלה."
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
                    : "מחיקת אצוות ה-Sandbox נכשלה."
            );
        }
    }

    return (
        <main className="brewing-view" dir="rtl">
            {sandbox && (
                <div className="brewing-sandbox-banner" role="status">
                    <strong>SANDBOX</strong>
                    <span>
                        ה-Preview מבודד: יצירת אצווה כאן אינה משנה Firestore, מיכלים או ACTION בפרודקשן.
                    </span>
                </div>
            )}

            {message && <div className="brewing-message">{message}</div>}

            {tab === "create" && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>מיכלים מחוטאים</h2>
                            <p>
                                {sandbox
                                    ? "אפשר ליצור אצוות בדיקה על בסיס מצב המיכלים האמיתי, ללא שינוי בפרודקשן."
                                    : "יצירת בישול תופעל לאחר השלמת תשתית ה-Sandbox וה-Drive."}
                            </p>
                        </div>
                        <span className="brewing-count">{visibleSanitizedTanks.length}</span>
                    </div>

                    {visibleSanitizedTanks.length === 0 ? (
                        <div className="brewing-empty">אין כרגע מיכלי ייצור מחוטאים.</div>
                    ) : (
                        <div className="brewing-tank-grid">
                            {visibleSanitizedTanks.map((tank) => {
                                const draft = drafts[tank.id] || {
                                    batchNumber: suggestedBatch,
                                    style: styles[0] || "IPA",
                                };
                                const productionAssignment =
                                    findProductionAssignment(draft.batchNumber);
                                const reassignmentPossible =
                                    productionAssignment &&
                                    Number(productionAssignment.action) === 0;
                                return (
                                    <article className="brewing-tank-card" key={tank.id}>
                                        <div className="brewing-tank-card-top">
                                            <strong>מיכל {String(tank.tankNumber ?? tank.id)}</strong>
                                            <span>
                                                {tank.id === demoTank.id
                                                    ? demoTank.tankType === "single"
                                                        ? "בודד"
                                                        : demoTank.tankType === "double"
                                                            ? "כפול"
                                                            : "משולש"
                                                    : tankType(tank.tankNumber)}
                                            </span>
                                        </div>

                                        <div className="brewing-tank-meta">
                                            <span>סטטוס: {tank.stage?.name || "מחוטא"}</span>
                                            {sandbox && tank.id === demoTank.id && (
                                                <span>מיכל פיקטיבי ל-Sandbox בלבד</span>
                                            )}
                                            {tank.batchNumber && (
                                                <span>אצווה קודמת: {String(tank.batchNumber)}</span>
                                            )}
                                        </div>

                                        {sandbox ? (
                                            <div className="brewing-create-fields">
                                                {tank.id === demoTank.id && (
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
                                                    סגנון
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
                                                                ? "האצווה עדיין לפני בישול. בפרודקשן נציע להעביר/להחליף את השיוך במקום ליצור אצווה כפולה."
                                                                : "האצווה כבר פעילה ולכן אי אפשר ליצור או להעביר אותה כאצווה חדשה."}
                                                        </span>
                                                    </div>
                                                ) : sandbox ? (
                                                    <small className="brewing-field-note">
                                                        בשלב הזה יצירת Sheet פעילה ל-IPA; שאר המתכונים יחוברו דרך brewRecipes.
                                                    </small>
                                                ) : null}
                                                <button
                                                    type="button"
                                                    onClick={() => void createSandbox(tank)}
                                                    disabled={
                                                        busyTankId === tank.id ||
                                                        !draft.batchNumber ||
                                                        !draft.style ||
                                                        Boolean(productionAssignment)
                                                    }
                                                >
                                                    {busyTankId === tank.id
                                                        ? "יוצר אצווה ו-Sheet..."
                                                        : "צור אצוות Sandbox + Sheet"}
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
                    )}
                </section>
            )}

            {tab === "recipes" && (
                <section className="brewing-panel">
                    {sandbox ? (
                        <BrewRecipeEditor onRecipeChange={setRecipe} />
                    ) : (
                        <>
                            <h2>מתכונים וחומרי גלם</h2>
                            <p>עריכת המתכונים תתחבר ל-brewRecipes לפני העלאה לפרודקשן.</p>
                        </>
                    )}
                </section>
            )}

            {tab === "form" && selectedRun && sandbox && (
                <BrewFormStepper
                    run={selectedRun}
                    recipe={selectedRun.recipeSnapshot || recipe}
                    onClose={() => setSelectedRun(null)}
                />
            )}

            {tab === "form" && !selectedRun && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>אצוות לפני / בזמן בישול</h2>
                            <p>אצוות Sandbox מוצגות בנפרד מאצוות הפרודקשן.</p>
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
                                    {demoTank.stageName} · {demoTank.tankType === "single" ? "בודד" : demoTank.tankType === "double" ? "כפול" : "משולש"}
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setDemoTank(resetSandboxDemoTank());
                                    setMessage("מיכל דמו 20 הוחזר למצב מחוטא.");
                                }}
                            >
                                החזר למחוטא
                            </button>
                        </div>
                    )}

                    {sandbox && sandboxRuns.length > 0 && (
                        <>
                            <h3 className="brewing-subheading">אצוות Sandbox</h3>
                            <div className="brewing-tank-grid">
                                {sandboxRuns.map((run) => (
                                    <article className="brewing-tank-card brewing-sandbox-card" key={run.batchNumber}>
                                        <div className="brewing-tank-card-top">
                                            <strong>אצווה {run.batchNumber}</strong>
                                            <span>{run.style}</span>
                                        </div>
                                        <div className="brewing-tank-meta">
                                            <span>מיכל {run.tankNumber}</span>
                                            <span>עדיין לא בבישול</span>
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
                                                disabled={!run.sheetId || openingBatch === run.batchNumber}
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
                                                {openingBatch === run.batchNumber
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
                                ))}
                            </div>
                        </>
                    )}

                    {waitingBrews.length > 0 && (
                        <>
                            <h3 className="brewing-subheading">אצוות פרודקשן — קריאה בלבד ב-Preview</h3>
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
                                            <span>מיכל {String(tank.tankNumber ?? tank.id)}</span>
                                            <span>
                                                {tank.brewProgress?.stageName || "עדיין לא בבישול"}
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
