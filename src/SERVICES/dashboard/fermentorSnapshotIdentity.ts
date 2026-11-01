type StageInput = {
    action?: unknown;
    batchNumber?: unknown;
    tankStatus?: unknown;
    currentData?: { temp?: unknown; notes?: unknown } | null;
    cellarState?: { batchNumber?: unknown; cooled?: unknown } | null;
};

function batchKey(value: unknown): string {
    return String(value ?? "").replace(/^#/, "").trim();
}
function temperaturePhase(value: unknown): "missing" | "cold" | "warm" | "unknown" {
    // Mirror getTankStage's actual 9°C threshold. A daily change within
    // the cold/warm phase must not reset the stage and reshuffle the cards.
    if (value === null || value === undefined) return "missing";
    const temperature = Number(value);
    if (Number.isNaN(temperature)) return "unknown";
    return temperature < 9 ? "cold" : "warm";
}
function coolingNote(value: unknown): boolean {
    return String(value ?? "").includes("קירור");
}

/** Pressure, annotations, sync clocks and unrelated server writes must not
 * force a second stage lookup or briefly reset the displayed tank stage.
 */
export function tankStageInputsEqual(previous: StageInput, next: StageInput): boolean {
    return previous.action === next.action &&
        batchKey(previous.batchNumber) === batchKey(next.batchNumber) &&
        previous.tankStatus === next.tankStatus &&
        temperaturePhase(previous.currentData?.temp) === temperaturePhase(next.currentData?.temp) &&
        coolingNote(previous.currentData?.notes) === coolingNote(next.currentData?.notes) &&
        batchKey(previous.cellarState?.batchNumber) === batchKey(next.cellarState?.batchNumber) &&
        previous.cellarState?.cooled === next.cellarState?.cooled;
}

/** Firestore can deliver metadata-only snapshots; no changed item => no
 * React state update and no downstream analytics / recommendation recalculation.
 */
export function sameTankReferences<T>(previous: readonly T[], next: readonly T[]): boolean {
    return previous.length === next.length && previous.every((item, index) => item === next[index]);
}
