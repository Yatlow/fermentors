import type { BrewRecipe } from "./brewRecipe";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { runtimeConfig } from "../../config/runtimeConfig";

export type SandboxBrewRun = {
    batchNumber: string;
    tankId: string;
    tankNumber: string;
    tankType: "single" | "double" | "triple";
    style: string;
    brewDate?: string;
    createdAt: string;
    source: "manual" | "planning" | "production";
    started: boolean;
    sheetId?: string;
    sheetUrl?: string;
    sheetName?: string;
    recipeSnapshot?: BrewRecipe;
    assignmentStatus?: "assigned" | "pending_sanitization";
};

const STORAGE_KEY = "fermentors:brewing-sandbox:runs:v1";

export function isBrewingSandbox(): boolean {
    return runtimeConfig.deployEnv === "preview";
}

export function getBrewingSandboxFolderId(): string {
    return runtimeConfig.brewingSandbox.folderId;
}

export function loadSandboxBrewRuns(): SandboxBrewRun[] {
    if (!isBrewingSandbox()) return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function persistSandboxBrewRuns(runs: SandboxBrewRun[]) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

export async function batchNumberExistsInProduction(batchNumber: string): Promise<boolean> {
    const clean = String(batchNumber || "").replace("#", "").trim();
    if (!clean) return false;
    const snapshot = await getDoc(doc(db, "brews", clean));
    return snapshot.exists();
}

export async function createSandboxBrewRun(input: Omit<SandboxBrewRun, "createdAt" | "started">) {
    if (!isBrewingSandbox()) {
        throw new Error("Sandbox brew creation is only enabled in preview builds.");
    }

    const batchNumber = String(input.batchNumber || "").replace("#", "").trim();
    if (!/^\d+$/.test(batchNumber)) {
        throw new Error("מספר אצווה חייב להיות מספר.");
    }

    if (await batchNumberExistsInProduction(batchNumber)) {
        throw new Error(`אצווה ${batchNumber} כבר קיימת בפרודקשן.`);
    }

    const existing = loadSandboxBrewRuns();
    if (existing.some((run) => run.batchNumber === batchNumber)) {
        throw new Error(`אצווה ${batchNumber} כבר קיימת ב-Sandbox.`);
    }

    const run: SandboxBrewRun = {
        ...input,
        batchNumber,
        createdAt: new Date().toISOString(),
        started: false,
    };

    persistSandboxBrewRuns([run, ...existing]);
    return run;
}

export function deleteSandboxBrewRun(batchNumber: string) {
    if (!isBrewingSandbox()) return;
    const clean = String(batchNumber || "").replace("#", "").trim();
    persistSandboxBrewRuns(loadSandboxBrewRuns().filter((run) => run.batchNumber !== clean));
}

export function clearSandboxBrewRuns() {
    if (!isBrewingSandbox()) return;
    window.localStorage.removeItem(STORAGE_KEY);
}


export type SandboxDemoTank = {
    id: "sandbox-tank-20";
    tankNumber: "20";
    tankType: "single" | "double" | "triple";
    action: 5 | 0;
    stageName: "מחוטא" | "בישול חדש";
};

const TANK_STORAGE_KEY = "fermentors:brewing-sandbox:tank20:v1";

export function loadSandboxDemoTank(): SandboxDemoTank {
    if (!isBrewingSandbox()) {
        return {
            id: "sandbox-tank-20",
            tankNumber: "20",
            tankType: "triple",
            action: 5,
            stageName: "מחוטא",
        };
    }

    try {
        const raw = window.localStorage.getItem(TANK_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<SandboxDemoTank>;
            if (
                parsed.id === "sandbox-tank-20" &&
                parsed.tankNumber === "20" &&
                ["single", "double", "triple"].includes(String(parsed.tankType)) &&
                [0, 5].includes(Number(parsed.action))
            ) {
                return {
                    id: "sandbox-tank-20",
                    tankNumber: "20",
                    tankType: parsed.tankType as SandboxDemoTank["tankType"],
                    action: Number(parsed.action) as SandboxDemoTank["action"],
                    stageName: Number(parsed.action) === 5 ? "מחוטא" : "בישול חדש",
                };
            }
        }
    } catch {
        // Fall back to a fresh demo tank.
    }

    return {
        id: "sandbox-tank-20",
        tankNumber: "20",
        tankType: "triple",
        action: 5,
        stageName: "מחוטא",
    };
}

function persistSandboxDemoTank(tank: SandboxDemoTank) {
    if (!isBrewingSandbox()) return;
    window.localStorage.setItem(TANK_STORAGE_KEY, JSON.stringify(tank));
}

export function setSandboxDemoTankType(
    tankType: SandboxDemoTank["tankType"],
): SandboxDemoTank {
    const current = loadSandboxDemoTank();
    const next = { ...current, tankType };
    persistSandboxDemoTank(next);
    return next;
}

export function markSandboxDemoTankBrewing(): SandboxDemoTank {
    const current = loadSandboxDemoTank();
    const next: SandboxDemoTank = {
        ...current,
        action: 0,
        stageName: "בישול חדש",
    };
    persistSandboxDemoTank(next);
    return next;
}

export function resetSandboxDemoTank(): SandboxDemoTank {
    const current = loadSandboxDemoTank();
    const next: SandboxDemoTank = {
        ...current,
        action: 5,
        stageName: "מחוטא",
    };
    persistSandboxDemoTank(next);
    return next;
}


export function attachSandboxSheet(
    batchNumber: string,
    sheet: { id: string; url: string; name: string },
): SandboxBrewRun | null {
    if (!isBrewingSandbox()) return null;
    const clean = String(batchNumber || "").replace("#", "").trim();
    const runs = loadSandboxBrewRuns();
    let updated: SandboxBrewRun | null = null;
    const next = runs.map((run) => {
        if (run.batchNumber !== clean) return run;
        updated = {
            ...run,
            sheetId: sheet.id,
            sheetUrl: sheet.url,
            sheetName: sheet.name,
        };
        return updated;
    });
    persistSandboxBrewRuns(next);
    return updated;
}


export function attachSandboxRecipeSnapshot(
    batchNumber: string,
    recipeSnapshot: BrewRecipe,
): SandboxBrewRun | null {
    if (!isBrewingSandbox()) return null;
    const clean = String(batchNumber || "").replace("#", "").trim();
    const runs = loadSandboxBrewRuns();
    let updated: SandboxBrewRun | null = null;
    const next = runs.map((run) => {
        if (run.batchNumber !== clean) return run;
        updated = {
            ...run,
            recipeSnapshot: JSON.parse(JSON.stringify(recipeSnapshot)) as BrewRecipe,
        };
        return updated;
    });
    persistSandboxBrewRuns(next);
    return updated;
}


export function setSandboxRunAssignmentStatus(
    batchNumber: string,
    assignmentStatus: "assigned" | "pending_sanitization",
): SandboxBrewRun | null {
    if (!isBrewingSandbox()) return null;
    const clean = String(batchNumber || "").replace("#", "").trim();
    const runs = loadSandboxBrewRuns();
    let updated: SandboxBrewRun | null = null;
    const next = runs.map((run) => {
        if (run.batchNumber !== clean) return run;
        updated = { ...run, assignmentStatus };
        return updated;
    });
    persistSandboxBrewRuns(next);
    return updated;
}

export function getSandboxQueueForTank(tankNumber: string): SandboxBrewRun[] {
    const cleanTank = String(tankNumber).trim();
    return loadSandboxBrewRuns()
        .filter(
            (run) =>
                String(run.tankNumber).trim() === cleanTank &&
                (run.assignmentStatus || "assigned") === "pending_sanitization",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function assignNextSandboxRunToTank(tankNumber: string): SandboxBrewRun | null {
    const nextRun = getSandboxQueueForTank(tankNumber)[0];
    if (!nextRun) return null;
    return setSandboxRunAssignmentStatus(nextRun.batchNumber, "assigned");
}
