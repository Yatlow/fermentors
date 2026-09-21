import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { runtimeConfig } from "../../config/runtimeConfig";

export type SandboxBrewRun = {
    batchNumber: string;
    tankId: string;
    tankNumber: string;
    tankType: "single" | "double" | "triple";
    style: string;
    createdAt: string;
    source: "manual" | "planning";
    started: boolean;
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
