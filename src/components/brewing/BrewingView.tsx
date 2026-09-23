import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import {
    serverListBrewDriveHistory,
    serverRenameBrewSheet,
    serverTrashBrewSheet,
    type BrewingDriveHistoryRow,
} from "../../SERVICES/brewing/brewingSheetServer";
import {
    loadSandboxRecipes,
    replaceSandboxRecipes,
} from "../../SERVICES/brewing/sandboxRecipe";
import {
    loadSandboxIngredients,
    saveSandboxIngredients,
} from "../../SERVICES/brewing/sandboxIngredients";
import {
    loadSharedBrewingLibrary,
    publishSharedBrewingLibrary,
    saveSharedBrewingIngredients,
    saveSharedBrewingRecipes,
} from "../../SERVICES/brewing/sharedBrewingLibrary";
import {
    subscribeCurrentWeekPlannedBrewHints,
    type PlannedBrewHint,
} from "../../SERVICES/brewing/planningBrewHints";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import { sameStyle } from "../../SERVICES/planning/planningEngine";
import {
    assignNextSandboxRunToTank,
    attachSandboxRecipeSnapshot,
    batchNumberExistsInProduction,
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
    productionBrewSheetExists,
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
        action: tank.action,
        brewSheetEditRevision:
            typeof tank.brewSheetEditRevision === "number" ? tank.brewSheetEditRevision : null,
        brewSheetEditRange:
            typeof tank.brewSheetEditRange === "string" ? tank.brewSheetEditRange : null,
        brewSheetEditValue:
            typeof tank.brewSheetEditValue === "string" ? tank.brewSheetEditValue : null,
        brewSheetEditOldValue:
            typeof tank.brewSheetEditOldValue === "string" ? tank.brewSheetEditOldValue : null,
        brewSheetEditSheetName:
            typeof tank.brewSheetEditSheetName === "string" ? tank.brewSheetEditSheetName : null,
        brewProgress: tank.brewProgress
            ? {
                  blockIndex: tank.brewProgress.blockIndex,
                  stageName: tank.brewProgress.stageName,
                  stageStartTimeText: tank.brewProgress.stageStartTimeText,
                  stageEndTimeText: tank.brewProgress.stageEndTimeText,
              }
            : null,
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
    const action = Number(tank.action);
    if (action === 1) {
        const stageName = String(tank.stage?.name || "").trim();
        return stageName === "קר" ? "קר" : "חם / בתסיסה";
    }

    const labels: Record<number, string> = {
        0: "בישול חדש",
        3: "מלוכלך / ריק",
        4: "נקי",
        5: "מחוטא",
    };
    return labels[action] || `ACTION ${String(tank.action ?? "—")}`;
}

function productionTankStageClass(tank: Fermentor): string {
    const action = Number(tank.action);
    if (action === 1) {
        return String(tank.stage?.name || "").trim() === "קר"
            ? "brew-tank-stage-cold"
            : "brew-tank-stage-hot";
    }
    if (action === 3) return "brew-tank-stage-dirty";
    if (action === 4) return "brew-tank-stage-clean";
    if (action === 5) return "brew-tank-stage-sanitized";
    return "brew-tank-stage-default";
}

export default function BrewingView({ brews, tab }: Props) {
    const sandbox = isBrewingSandbox();
    const [sandboxRuns, setSandboxRuns] = useState<SandboxBrewRun[]>(() => loadSandboxBrewRuns());
    const [recipes, setRecipes] = useState<BrewRecipe[]>(() => loadSandboxRecipes());
    const [ingredients, setIngredients] = useState(() => loadSandboxIngredients());
    const [sharedLibraryReady, setSharedLibraryReady] = useState(false);
    const [sharedLibraryLoading, setSharedLibraryLoading] = useState(false);
    const [publishingSharedLibrary, setPublishingSharedLibrary] = useState(false);
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
    const [quickCreateHint, setQuickCreateHint] = useState<PlannedBrewHint | null>(null);
    const [deletingBatch, setDeletingBatch] = useState<string | null>(null);
    const [editingTankId, setEditingTankId] = useState<string | null>(null);
    const [productionHistory, setProductionHistory] =
        useState<BrewingDriveHistoryRow[]>([]);
    const [pendingProductionRows, setPendingProductionRows] = useState<BrewingDriveHistoryRow[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [deleteConfirmation, setDeleteConfirmation] = useState<SandboxBrewRun | null>(null);
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

    useEffect(() => {
        if (!selectedRun || selectedRun.source !== "production" || selectedRun.tankId.startsWith("history-")) {
            return;
        }

        const tank = brews.find((item) => item.id === selectedRun.tankId);
        if (!tank) return;
        const liveRun = productionRunFromTank(tank);
        if (!liveRun) return;

        const changed =
            liveRun.action !== selectedRun.action ||
            liveRun.brewSheetEditRevision !== selectedRun.brewSheetEditRevision ||
            liveRun.brewSheetEditRange !== selectedRun.brewSheetEditRange ||
            liveRun.brewSheetEditValue !== selectedRun.brewSheetEditValue ||
            liveRun.brewSheetEditSheetName !== selectedRun.brewSheetEditSheetName ||
            liveRun.brewProgress?.stageName !== selectedRun.brewProgress?.stageName ||
            liveRun.brewProgress?.stageStartTimeText !== selectedRun.brewProgress?.stageStartTimeText ||
            liveRun.brewProgress?.stageEndTimeText !== selectedRun.brewProgress?.stageEndTimeText;

        if (changed) setSelectedRun(liveRun);
    }, [brews, selectedRun]);

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

        const matching =
            recipes.find((item) => sameStyle(item.style, selectedRun.style)) ||
            recipes.find(
                (item) =>
                    item.id.toLowerCase() ===
                    selectedRun.style.trim().toLowerCase(),
            );

        const snapshot = selectedRun.recipeSnapshot;
        const snapshotHasMaterials =
            !!snapshot &&
            (snapshot.grains.length > 0 ||
                snapshot.hops.length > 0 ||
                !!snapshot.yeast.ingredientId);

        if (snapshotHasMaterials) return snapshot;
        if (matching) return matching;
        return selectedRun.source === "production"
            ? null
            : snapshot || recipes[0] || null;
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

    const visiblePlanningHints = useMemo(() => {
        const created = new Set(
            [
                ...brews.map((tank) => String(tank.batchNumber || "").replace("#", "").trim()),
                ...pendingProductionRows.map((row) => String(row.batchNumber || "").replace("#", "").trim()),
            ].filter(Boolean),
        );
        return planningHints.filter(
            (hint) => !created.has(String(hint.batchNumber).replace("#", "").trim()),
        );
    }, [planningHints, brews, pendingProductionRows]);

    const pendingProductionRuns = useMemo(
        () => pendingProductionRows
            .map(productionRunFromSummary)
            .filter((run): run is SandboxBrewRun => !!run)
            .filter((run) => !currentProductionBatchNumbers.has(run.batchNumber)),
        [pendingProductionRows, currentProductionBatchNumbers],
    );

    const pendingBatchNumbers = useMemo(
        () => new Set(pendingProductionRuns.map((run) => run.batchNumber)),
        [pendingProductionRuns],
    );

    const driveProductionRuns = useMemo(
        () => productionHistory
            .map(productionRunFromSummary)
            .filter((run): run is SandboxBrewRun => !!run)
            .filter((run) => !currentProductionBatchNumbers.has(run.batchNumber)),
        [productionHistory, currentProductionBatchNumbers],
    );

    const historicalProductionRuns = useMemo(() => {
        const query = historyQuery.trim().toLowerCase();
        return driveProductionRuns
            .filter((run) => !pendingBatchNumbers.has(run.batchNumber))
            .filter((run) => {
                if (!query) return true;
                return [run.batchNumber, run.style, run.tankNumber, run.brewDate || ""]
                    .some((value) => String(value).toLowerCase().includes(query));
            })
            .slice(0, query ? 30 : 12);
    }, [driveProductionRuns, pendingBatchNumbers, historyQuery]);

    useEffect(() => {
        if (!sandbox) return;

        let cancelled = false;
        setSharedLibraryLoading(true);

        loadSharedBrewingLibrary()
            .then((library) => {
                if (cancelled || !library.hasRemoteLibrary) return;

                const nextRecipes = replaceSandboxRecipes(library.recipes);
                const nextIngredients = saveSandboxIngredients(library.ingredients);
                setRecipes(nextRecipes);
                setIngredients(nextIngredients);
                setSharedLibraryReady(true);
            })
            .catch((error) => {
                console.warn("Failed loading shared brewing library", error);
            })
            .finally(() => {
                if (!cancelled) setSharedLibraryLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [sandbox]);

    async function publishLibrary() {
        setPublishingSharedLibrary(true);
        setMessage("");
        try {
            await publishSharedBrewingLibrary(recipes, ingredients);
            replaceSandboxRecipes(recipes);
            saveSandboxIngredients(ingredients);
            setSharedLibraryReady(true);
            setMessage("✓ ספריית המתכונים וחומרי הגלם נשמרה.");
        } catch (error) {
            setMessage(
                error instanceof Error
                    ? error.message
                    : "שמירת ספריית הבישול נכשלה.",
            );
        } finally {
            setPublishingSharedLibrary(false);
        }
    }

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
        return onSnapshot(collection(db, "pendingBrews"), (snapshot) => {
            setPendingProductionRows(snapshot.docs.map((item) => {
                const data = item.data();
                return {
                    id: item.id,
                    fileId: String(data.fileId || ""),
                    fileName: String(data.fileName || ""),
                    batchNumber: String(data.batchNumber || item.id),
                    beerStyle: String(data.beerStyle || ""),
                    brewDate: "",
                    sheetUrl: String(data.sheetUrl || ""),
                    tankNumber: String(data.tankNumber || ""),
                    tankType: data.tankType,
                } as BrewingDriveHistoryRow;
            }));
        });
    }, []);

    useEffect(() => {
        let cancelled = false;
        // Drive history is deliberately background-only. The operational top
        // of the page is driven by Firestore and must not wait for this scan.
        setHistoryLoading(true);
        serverListBrewDriveHistory(100)
            .then((rows) => {
                if (cancelled) return;
                setProductionHistory(rows);
            })
            .catch(() => {
                if (!cancelled) setProductionHistory([]);
            })
            .finally(() => {
                if (!cancelled) setHistoryLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const numbers = [
            ...brews.map((tank) => Number(String(tank.batchNumber || "").replace("#", "").trim())),
            ...pendingProductionRows.map((row) => Number(String(row.batchNumber || "").replace("#", "").trim())),
            ...planningHints.map((hint) => Number(String(hint.batchNumber || "").replace("#", "").trim())),
        ].filter(Number.isFinite);
        if (!numbers.length) return;
        const sandboxUsed = new Set(sandboxRuns.map((run) => Number(run.batchNumber)));
        let candidate = Math.max(...numbers) + 1;
        while (sandboxUsed.has(candidate)) candidate += 1;
        setSuggestedBatch(String(candidate));
    }, [brews, pendingProductionRows, planningHints, sandboxRuns]);

    useEffect(() => {
        setPlanningHintsLoading(true);
        let firstValue = true;
        return subscribeCurrentWeekPlannedBrewHints((result) => {
            setPlanningHints(result.hints);
            setPlanningHintsAvailable(result.available);
            if (firstValue) {
                firstValue = false;
                setPlanningHintsLoading(false);
            }
        });
    }, []);

    useEffect(() => {
        if (planningHints.length === 0) return;

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
    }, [planningHints, brews, sandboxRuns]);

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

        const isDemoTank = tank.id === demoTank.id;

        const recipe =
            recipes.find((item) => item.style === draft.style) ||
            recipes.find((item) => item.id === "ipa");
        if (!recipe) {
            setCreateModalError("לא נמצא מתכון לסגנון שנבחר.");
            return;
        }

        if (!isDemoTank) {
            setMessage("");
            setCreateModalError("");
            setBusyTankId(tank.id);

            try {
                if (await batchNumberExistsInProduction(draft.batchNumber)) {
                    throw new Error(
                        `אצווה ${draft.batchNumber} כבר קיימת ב-Firestore.`,
                    );
                }

                if (await productionBrewSheetExists(draft.batchNumber)) {
                    throw new Error(
                        `כבר קיים ב-Drive טופס בישול לאצווה ${draft.batchNumber}.`,
                    );
                }

                await ensureSandboxSheetAccess();
                const sheet = await createSandboxBrewSheet({
                    batchNumber: draft.batchNumber,
                    style: draft.style,
                    tankNumber: String(tank.tankNumber ?? tank.id),
                    tankType: tankTypeKey(tank.tankNumber, draft.style),
                    recipe,
                    ingredients,
                    production: true,
                });

                const sanitized = Number(tank.action) === 5;
                setMessage(
                    sanitized
                        ? `✓ אצווה ${draft.batchNumber} נוצרה כטופס אמיתי בתיקיית הבישולים. מיכל ${String(
                              tank.tankNumber ?? tank.id,
                          )} מחוטא, ולכן ACTION 5 יוכל לשבץ אותה במחזור הקרוב.`
                        : `✓ אצווה ${draft.batchNumber} נוצרה כטופס אמיתי וממתינה בתיקיית הבישולים עד שמיכל ${String(
                              tank.tankNumber ?? tank.id,
                          )} יהיה מחוטא.`,
                );
                await setDoc(doc(db, "pendingBrews", String(draft.batchNumber)), {
                    batchNumber: String(draft.batchNumber),
                    beerStyle: draft.style,
                    tankNumber: String(tank.tankNumber ?? tank.id),
                    tankType: tankTypeKey(tank.tankNumber, draft.style),
                    fileId: sheet.id,
                    fileName: sheet.name,
                    sheetUrl: sheet.url,
                    createdAt: serverTimestamp(),
                });

                setProductionHistory((current) => [
                    {
                        id: sheet.id,
                        fileId: sheet.id,
                        fileName: sheet.name,
                        batchNumber: draft.batchNumber,
                        beerStyle: draft.style,
                        brewDate: "",
                        sheetUrl: sheet.url,
                        tankNumber: String(tank.tankNumber ?? tank.id),
                        tankType: tankTypeKey(tank.tankNumber, draft.style),
                    },
                    ...current.filter(
                        (item) =>
                            String(item.batchNumber) !==
                            String(draft.batchNumber),
                    ),
                ]);
                setSuggestedBatch(String(Number(draft.batchNumber) + 1));
                setShowCreate(false);
                return;
            } catch (error) {
                setCreateModalError(
                    error instanceof Error
                        ? error.message
                        : "יצירת אצוות הבישול האמיתית נכשלה.",
                );
                return;
            } finally {
                setBusyTankId(null);
            }
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
                    ? `✓ אצווה ${run.batchNumber} נוצרה ושויכה למיכל ${run.tankNumber} .`
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
                    : "יצירת אצווה וה-Sheet נכשלה.",
            );
        } finally {
            setBusyTankId(null);
        }
    }

    async function removeSandboxRun(run: SandboxBrewRun) {
        setMessage("");
        setDeletingBatch(run.batchNumber);
        try {
            // Never remove the local run first. If Drive deletion fails we keep
            // the batch visible so the user can retry and we do not create an
            // orphan Sheet that is hard to find later.
            if (run.sheetId) {
                await deleteSandboxBrewSheet(run.sheetId);
            }
            deleteSandboxBrewRun(run.batchNumber);
            setSandboxRuns(loadSandboxBrewRuns());
            setMessage(`אצווה ${run.batchNumber} וה-Sheet שלה נמחקו.`);
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : "מחיקת ה-Sheet נכשלה.";
            setMessage(
                `אצווה ${run.batchNumber} לא נמחקה כדי לא להשאיר Sheet יתום. ${detail}`,
            );
        } finally {
            setDeletingBatch(null);
        }
    }

    async function editUnstartedProductionBatch(tank: Fermentor) {
        if (Number(tank.action) !== 0) return;
        const run = productionRunFromTank(tank);
        if (!run?.sheetId) return;

        const nextBatch = window.prompt("מספר אצווה", run.batchNumber)?.replace(/\D/g, "").trim();
        if (!nextBatch) return;
        const nextStyle = window.prompt("סגנון", run.style)?.trim();
        if (!nextStyle) return;
        if (nextBatch === run.batchNumber && nextStyle === run.style) return;

        setEditingTankId(tank.id);
        setMessage("");
        try {
            if (
                nextBatch !== run.batchNumber &&
                (await batchNumberExistsInProduction(nextBatch) ||
                    await productionBrewSheetExists(nextBatch))
            ) {
                throw new Error(`אצווה ${nextBatch} כבר קיימת.`);
            }

            await serverRenameBrewSheet({
                spreadsheetId: run.sheetId,
                oldBatchNumber: run.batchNumber,
                newBatchNumber: nextBatch,
                style: nextStyle,
            });
            await updateDoc(doc(db, "fermentors", tank.id), {
                batchNumber: nextBatch,
                beerStyle: nextStyle,
            });
            setMessage(`✓ אצווה ${run.batchNumber} עודכנה ל-${nextBatch} · ${nextStyle}.`);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "עדכון האצווה נכשל.");
        } finally {
            setEditingTankId(null);
        }
    }

    async function editPendingProductionBatch(run: SandboxBrewRun) {
        if (run.brewDate || !run.sheetId) return;
        const nextBatch = window.prompt("מספר אצווה", run.batchNumber)?.replace(/\\D/g, "").trim();
        if (!nextBatch) return;
        const nextStyle = window.prompt("סגנון", run.style)?.trim();
        if (!nextStyle) return;
        if (nextBatch === run.batchNumber && nextStyle === run.style) return;

        setEditingTankId(run.tankId);
        setMessage("");
        try {
            if (
                nextBatch !== run.batchNumber &&
                (await batchNumberExistsInProduction(nextBatch) ||
                    await productionBrewSheetExists(nextBatch))
            ) {
                throw new Error(`אצווה ${nextBatch} כבר קיימת.`);
            }
            await serverRenameBrewSheet({
                spreadsheetId: run.sheetId,
                oldBatchNumber: run.batchNumber,
                newBatchNumber: nextBatch,
                style: nextStyle,
            });
            const pendingRef = doc(db, "pendingBrews", run.batchNumber);
            if (nextBatch !== run.batchNumber) {
                await setDoc(doc(db, "pendingBrews", nextBatch), {
                    batchNumber: nextBatch,
                    beerStyle: nextStyle,
                    tankNumber: run.tankNumber === "—" ? "" : run.tankNumber,
                    tankType: run.tankType,
                    fileId: run.sheetId,
                    fileName: "",
                    sheetUrl: run.sheetUrl,
                    createdAt: serverTimestamp(),
                });
                await deleteDoc(pendingRef);
            } else {
                await updateDoc(pendingRef, { beerStyle: nextStyle });
            }
            setProductionHistory((current) =>
                current.map((row) =>
                    String(row.batchNumber).replace("#", "").trim() === run.batchNumber
                        ? { ...row, batchNumber: nextBatch, beerStyle: nextStyle }
                        : row,
                ),
            );
            setMessage(`✓ אצווה ${run.batchNumber} עודכנה ל-${nextBatch} · ${nextStyle}.`);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "עדכון האצווה נכשל.");
        } finally {
            setEditingTankId(null);
        }
    }

    async function deletePendingProductionBatch(run: SandboxBrewRun) {
        if (run.brewDate || !run.sheetId) return;
        setDeleteConfirmation(null);
        setDeletingBatch(run.batchNumber);
        setMessage("");
        try {
            await serverTrashBrewSheet(run.sheetId);
            await deleteDoc(doc(db, "pendingBrews", run.batchNumber));
            setProductionHistory((current) =>
                current.filter(
                    (row) => String(row.batchNumber).replace("#", "").trim() !== run.batchNumber,
                ),
            );
            setMessage(`✓ אצווה ${run.batchNumber} נמחקה.`);
        } catch (error) {
            setMessage(error instanceof Error ? `האצווה לא נמחקה: ${error.message}` : "מחיקת האצווה נכשלה.");
        } finally {
            setDeletingBatch(null);
        }
    }

    async function deleteUnstartedProductionBatch(tank: Fermentor) {
        if (Number(tank.action) !== 0) return;
        const run = productionRunFromTank(tank);
        if (!run?.sheetId) return;
        setDeleteConfirmation(null);

        setDeletingBatch(run.batchNumber);
        setMessage("");
        try {
            await serverTrashBrewSheet(run.sheetId);
            await updateDoc(doc(db, "fermentors", tank.id), {
                batchNumber: "",
                beerStyle: "",
                brewDate: "",
                sheetUrl: "",
                action: 5,
                tankStatus: false,
            });
            setSelectedRun(null);
            setMessage(`✓ אצווה ${run.batchNumber} נמחקה והמיכל הוחזר למחוטא.`);
        } catch (error) {
            setMessage(
                error instanceof Error
                    ? `האצווה לא נמחקה: ${error.message}`
                    : "מחיקת האצווה נכשלה.",
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

    async function confirmDeleteProductionBatch() {
        if (!deleteConfirmation) return;
        const tank = brews.find((item) =>
            String(item.batchNumber || "").replace("#", "").trim() === deleteConfirmation.batchNumber &&
            Number(item.action) === 0
        );
        if (tank) await deleteUnstartedProductionBatch(tank);
        else await deletePendingProductionBatch(deleteConfirmation);
    }

    return (
        <main className="brewing-view" dir="rtl">
            {deleteConfirmation && (
                <div className="brewing-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteConfirmation(null); }}>
                    <div className="brewing-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="brew-delete-title">
                        <h3 id="brew-delete-title">מחיקת אצווה {deleteConfirmation.batchNumber}</h3>
                        <p>ה-Sheet של האצווה יועבר לפח. הפעולה מיועדת רק לאצווה שעדיין לא התחילה בבישול.</p>
                        <div className="brewing-confirm-actions">
                            <button type="button" onClick={() => setDeleteConfirmation(null)}>ביטול</button>
                            <button type="button" className="brewing-danger-button" disabled={deletingBatch === deleteConfirmation.batchNumber} onClick={() => void confirmDeleteProductionBatch()}>
                                {deletingBatch === deleteConfirmation.batchNumber ? "מוחק…" : "מחק אצווה"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {tab === "form" && !selectedRun && actionZeroProductionTanks.length > 0 && (
                <section className="brewing-action-zero-strip" aria-label="מיכלים ב-ACTION 0">
                    <div className="brewing-action-zero-heading">
                        <strong>מיכלים בישול חדש</strong>
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
                                <>
                                <button
                                    type="button"
                                    className="brewing-action-zero-chip"
                                    key={tank.id}
                                    disabled={!run || !recipe}
                                    onClick={() => {
                                        if (!run) return;
                                        setMessage("");
                                        setSelectedRun(run);
                                    }}
                                >
                                    <div className="brewing-action-zero-main">
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
                                    </div>
                                    {run && (
                                        <div className="brewing-action-zero-progress">
                                            {run.brewProgress?.stageName ? (
                                                <>
                                                    <span className="brewing-action-zero-live-dot" />
                                                    <strong>
                                                        {run.brewProgress.blockIndex
                                                            ? `בישול ${String.fromCharCode(
                                                                  64 +
                                                                      Number(
                                                                          run.brewProgress.blockIndex,
                                                                      ),
                                                              )}`
                                                            : "בישול"}
                                                    </strong>
                                                    <span>
                                                        {run.brewProgress.stageName}
                                                    </span>
                                                    {run.brewProgress.stageStartTimeText && (
                                                        <small>
                                                            {run.brewProgress.stageStartTimeText}
                                                            {run.brewProgress.stageEndTimeText
                                                                ? `–${run.brewProgress.stageEndTimeText}`
                                                                : ""}
                                                        </small>
                                                    )}
                                                </>
                                            ) : (
                                                <small>עדיין לא בבישול</small>
                                            )}
                                        </div>
                                    )}
                                    {!run && (
                                        <small>ללא Sheet משויך</small>
                                    )}
                                </button>
                                {run && Number(tank.action) === 0 && !run.brewProgress?.stageName && (
                                    <div className="brewing-prebrew-actions">
                                        <button
                                            type="button"
                                            disabled={editingTankId === tank.id}
                                            onClick={() => void editUnstartedProductionBatch(tank)}
                                        >
                                            ערוך אצווה
                                        </button>
                                        <button
                                            type="button"
                                            className="brewing-danger-button"
                                            disabled={deletingBatch === run.batchNumber}
                                            onClick={() => run && setDeleteConfirmation(run)}
                                        >
                                            מחק
                                        </button>
                                    </div>
                                )}
                                </>
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

            {message && <div className="brewing-message">{message}</div>}

            {tab === "form" && !selectedRun && (
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
                        setQuickCreateHint(null);
                        setShowCreate(false);
                    }}
                    onDemoTankTypeChange={(value) =>
                        setDemoTank(setSandboxDemoTankType(value))
                    }
                    initialDraft={quickCreateHint ? {
                        batchNumber: quickCreateHint.batchNumber,
                        style: quickCreateHint.style,
                        tankId: quickCreateHint.tankId,
                    } : undefined}
                    onCreate={createSandbox}
                />
            )}

            {tab === "recipes" && (
                <section className="brewing-panel">
                    {sandbox ? (
                        <BrewingLibrary
                            recipes={recipes}
                            ingredients={ingredients}
                            sharedLibraryReady={sharedLibraryReady}
                            publishingSharedLibrary={
                                publishingSharedLibrary || sharedLibraryLoading
                            }
                            onPublishSharedLibrary={() => void publishLibrary()}
                            onRecipesChange={(next) => {
                                setRecipes(next);
                                replaceSandboxRecipes(next);
                                if (sharedLibraryReady) {
                                    void saveSharedBrewingRecipes(next).catch(
                                        (error) => {
                                            console.error(
                                                "Failed saving shared recipe library",
                                                error,
                                            );
                                        },
                                    );
                                }
                            }}
                            onIngredientsChange={(next) => {
                                setIngredients(next);
                                saveSandboxIngredients(next);
                                if (sharedLibraryReady) {
                                    void saveSharedBrewingIngredients(next).catch(
                                        (error) => {
                                            console.error(
                                                "Failed saving shared ingredient library",
                                                error,
                                            );
                                            setMessage(
                                                "שמירת חומרי הגלם נכשלה.",
                                            );
                                        },
                                    );
                                }
                            }}
                        />
                    ) : (
                        <>
                            <h2>מתכונים וחומרי גלם</h2>
                            <p>ספריית המתכונים וחומרי הגלם אינה זמינה כרגע.</p>
                        </>
                    )}
                </section>
            )}

            {tab === "form" && selectedRun && selectedRecipe && (
                <BrewFormStepper
                    run={selectedRun}
                    recipe={selectedRecipe}
                    ingredients={ingredients}
                    onClose={() => setSelectedRun(null)}
                />
            )}

            {tab === "form" && !selectedRun && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>אצוות בישול</h2>
                            <p>
                                אצוות במיכלים ואצוות קודמות. העריכה מעדכנת את ה-Sheet המקורי.
                            </p>
                        </div>
                        <div className="brewing-heading-actions">
                            <span className="brewing-count">
                                {sandboxRuns.length + editableProductionTanks.length}
                            </span>
                            <button
                                type="button"
                                className="btn-primary brewing-create-button"
                                onClick={() => {
                                    setCreateModalError("");
                                    setQuickCreateHint(null);
                                    setShowCreate(true);
                                }}
                            >
                                + יצירת בישול חדש
                            </button>
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
                            <h3 className="brewing-subheading">אצוות דמו · מיכל 20</h3>
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

                    {pendingProductionRuns.length > 0 && (
                        <div className="brewing-history-section brewing-pending-section">
                            <div className="brewing-history-heading">
                                <div>
                                    <h3 className="brewing-subheading">אצוות עתידיות ממתינות למיכל מחוטא</h3>
                                    <small>ה-Sheet כבר נוצר · האצווה ממתינה למיכל מחוטא וניתן לפתוח, לערוך או למחוק עד השיבוץ</small>
                                </div>
                                <span className="brewing-count">{pendingProductionRuns.length}</span>
                            </div>
                            <div className="brewing-tank-grid">
                                {pendingProductionRuns.map((run) => {
                                    const style = beerStyleClass(run.style);
                                    return (
                                        <article className="brewing-tank-card brewing-pending-card" key={`pending-${run.batchNumber}`}>
                                            <div className="brewing-tank-card-top">
                                                <strong>אצווה {run.batchNumber}</strong>
                                                <span className={`brewing-style-tag ${style.className}`}>{style.displayLabel}</span>
                                            </div>
                                            <div className="brewing-tank-meta">
                                                <span>{run.tankNumber === "—" ? "מיכל לא ידוע" : `מיועד למיכל ${run.tankNumber}`}</span>
                                                <span>ממתינה לשיבוץ</span>
                                            </div>
                                            <div className="brewing-card-actions">
                                                <a className="brewing-sheet-link" href={run.sheetUrl} target="_blank" rel="noreferrer">פתח Sheet</a>
                                                <button type="button" disabled={editingTankId === run.tankId} onClick={() => void editPendingProductionBatch(run)}>ערוך אצווה</button>
                                                <button type="button" className="brewing-danger-button" disabled={deletingBatch === run.batchNumber} onClick={() => setDeleteConfirmation(run)}>מחק</button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className="brewing-planned-quick brewing-planned-inline">
                    <div className="brewing-panel-heading brewing-planned-inline-heading">
                        <div>
                            <h2>בישולים מתוכננים</h2>
                            <p>השבוע והשבוע הבא · לחץ על אצווה כדי ליצור אותה</p>
                        </div>
                        {!planningHintsLoading && planningHintsAvailable && visiblePlanningHints.length > 0 && (
                            <span className="brewing-count">{visiblePlanningHints.length}</span>
                        )}
                    </div>
                    <div className="brewing-tank-grid brewing-planned-quick-list">
                        {planningHintsLoading && <small>טוען בישולים מתוכננים…</small>}
                        {!planningHintsLoading && !planningHintsAvailable && (
                            <small>לא ניתן לטעון כרגע את תכנון הבישולים.</small>
                        )}
                        {!planningHintsLoading && planningHintsAvailable && visiblePlanningHints.length === 0 && (
                            <small>לא נמצאו בישולים מתוכננים לשבוע הזה או לשבוע הבא.</small>
                        )}
                        {visiblePlanningHints.map((hint) => {
                                const tank = allTanks.find((item) => item.id === hint.tankId);
                                return (
                                    <button
                                        type="button"
                                        key={`quick-${hint.batchNumber}-${hint.tankId}-${hint.date}`}
                                        className="brewing-tank-card brewing-planned-quick-card"
                                        onClick={() => {
                                            setQuickCreateHint(hint);
                                            setSuggestedBatch(String(hint.batchNumber));
                                            setShowCreate(true);
                                        }}
                                    >
                                        <strong>#{hint.batchNumber} · {hint.style}</strong>
                                        <span>
                                            {tank?.tankNumber ? `מיכל ${tank.tankNumber}` : "ללא מיכל"}
                                            {hint.date ? ` · ${hint.date}` : ""}
                                        </span>
                                        <small>צור אצווה</small>
                                    </button>
                                );
                            })}
                    </div>
                
                    </div>

                    {otherProductionTanks.length > 0 && (
                        <>
                            <h3 className="brewing-subheading">
                                אצוות במיכל
                            </h3>
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
                                            className={`brewing-tank-card brewing-production-card ${productionTankStageClass(
                                                tank,
                                            )}`}
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
                                                          : "עריכת נתוני בישול"}
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
                                <h3 className="brewing-subheading">אצוות קודמות</h3>
                                <small>חיפוש מתוך 100 האצוות האחרונות ב-Drive</small>
                            </div>
                            <input type="search" value={historyQuery} placeholder="אצווה / סגנון / מיכל / תאריך" onChange={(event) => setHistoryQuery(event.target.value)} />
                        </div>
                        {historyLoading ? (
                            <div className="brewing-history-loader"><BeerLoader size="small" message="טוען אצוות…" /></div>
                        ) : historicalProductionRuns.length > 0 ? (
                            <div className="brewing-tank-grid">
                                {historicalProductionRuns.map((run) => {
                                    const style = beerStyleClass(run.style);
                                    const recipe = recipes.find((item) => sameStyle(item.style, run.style)) || null;
                                    return (
                                        <article className="brewing-tank-card brewing-history-card" key={`history-${run.batchNumber}`}>
                                            <div className="brewing-tank-card-top">
                                                <strong>אצווה {run.batchNumber}</strong>
                                                <span className={`brewing-style-tag ${style.className}`}>{style.displayLabel}</span>
                                            </div>
                                            <div className="brewing-tank-meta">
                                                <span>{run.tankNumber === "—" ? "מיכל לא ידוע" : `מיכל ${run.tankNumber}`}</span>
                                                <span>{run.brewDate}</span>
                                            </div>
                                            <div className="brewing-card-actions">
                                                <a className="brewing-sheet-link" href={run.sheetUrl} target="_blank" rel="noreferrer">פתח Sheet</a>
                                                <button type="button" disabled={!sandbox || !recipe} onClick={() => { setMessage(""); setSelectedRun(run); }}>
                                                    {!recipe ? "חסר מתכון תואם" : "עריכת נתוני בישול"}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="brewing-empty">{historyQuery ? "לא נמצאה אצווה קודמת תואמת." : "לא נמצאו אצוות קודמות."}</div>
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
