import type { Measurement } from "./calculateCelleringRecomendations";
import { hasActualCooling } from "./neglectAfterCooling";
import { DEFAULT_WARM_FERMENTATION_PLATO_DELTA } from "./fermentationEndPlato";

export type WarmFermentationTest = {
    batchNumber: string;
    requestId?: string;
    plato: number;
    pH?: number | null;
    coolingPlato: number | null;
    recordedAt: string;
    packaged: boolean;
    inTank: boolean;
    tankNumber: string | null;
    sheetUrl: string;
};

export function normalizeWarmBatch(value: unknown): string {
    return String(value ?? "").replace(/^#/, "").trim();
}

export function parseWarmPlato(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const parsed = Number(String(value).trim().replace(",", "."));
    // Deliberately reject negative / implausible values rather than silently accepting them.
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 40 ? parsed : null;
}

export function coolingPlatoAtRecordedCooling(rows: Measurement[]): number | null {
    const ordered = [...rows].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
    let lastPlato: number | null = null;
    let coolingPlato: number | null = null;
    for (const row of ordered) {
        const value = parseWarmPlato(row.plato);
        if (value !== null) lastPlato = value;
        if (hasActualCooling(String(row.notes ?? ""))) {
            // Use the last real tank reading AT cooling. A measurement taken after
            // cooling must never be substituted for the cooling baseline.
            coolingPlato = lastPlato;
        }
    }
    return coolingPlato;
}

export function warmPlatoDifference(test: number, cooling: number | null): number | null {
    if (cooling === null || !Number.isFinite(cooling)) return null;
    const delta = Math.round((cooling - test) * 100) / 100;
    return delta === 0 ? null : delta;
}

export function getWarmFermentationGapThreshold(specs?: { tolorances?: Record<string, number> } | null): number {
    const configured = specs?.tolorances?.warmFermentationPlatoDelta;
    return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
        ? configured : DEFAULT_WARM_FERMENTATION_PLATO_DELTA;
}

export function warmTestWarning(params: {
    packaged: boolean;
    isCold: boolean;
    testPlato: number;
    coolingPlato: number | null;
    threshold?: number;
}): string | null {
    const delta = warmPlatoDifference(params.testPlato, params.coolingPlato);
    const threshold = params.threshold ?? DEFAULT_WARM_FERMENTATION_PLATO_DELTA;
    if (delta === null || Math.abs(delta) + 1e-9 < threshold) return null;
    const direction = delta > 0 ? "נמוכה" : "גבוהה";
    const lead = `בדיקת התסיסה החמה (${params.testPlato}°P) ${direction} מפלאטו הקירור (${params.coolingPlato}°P) בהפרש של ${Math.abs(delta)}°P.`;
    if (params.packaged) return `${lead} האצווה כבר נארזה. מומלץ לבחון את הפער ולתעד החלטת איכות; לא משנים בדיעבד את נתוני האצווה.`;
    if (params.isCold) return `${lead} הבירה כבר קרה. מומלץ לשקול האם יש צורך לשנות את יעד הגיזוז בהתאם לתסיסה הנוספת האפשרית. היעד לא ישונה אוטומטית.`;
    return `${lead} מומלץ לוודא את תקינות התוצאה לפני המשך התהליך.`;
}

export function warmTestBlocksCooling(
    stage: string | null | undefined,
    currentPlato: number | null,
    testPlato: number | null,
): boolean {
    return stage === "בתסיסה" &&
        currentPlato !== null && testPlato !== null &&
        currentPlato > testPlato;
}
