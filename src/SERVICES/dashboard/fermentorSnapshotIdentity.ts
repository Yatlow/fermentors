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
function isTrue(value: unknown): boolean {
    return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

/** Pressure, annotations, sync clocks and unrelated server writes must not
 * force a second stage lookup or briefly reset the displayed tank stage.
 */
export function tankStageInputsEqual(previous: StageInput, next: StageInput): boolean {
    return Number(previous.action) === Number(next.action) &&
        batchKey(previous.batchNumber) === batchKey(next.batchNumber) &&
        isTrue(previous.tankStatus) === isTrue(next.tankStatus) &&
        previous.currentData?.temp === next.currentData?.temp &&
        String(previous.currentData?.notes ?? "") === String(next.currentData?.notes ?? "") &&
        batchKey(previous.cellarState?.batchNumber) === batchKey(next.cellarState?.batchNumber) &&
        previous.cellarState?.cooled === next.cellarState?.cooled;
}

/** Firestore can deliver metadata-only snapshots; no changed item => no
 * React state update and no downstream analytics / recommendation recalculation.
 */
export function sameTankReferences<T>(previous: readonly T[], next: readonly T[]): boolean {
    return previous.length === next.length && previous.every((item, index) => item === next[index]);
}
