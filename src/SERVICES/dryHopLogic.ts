import type { SpecChart } from "./getSpecsFromFb";

export type DryHopStyleCategory = "ipa" | "pale" | "hoppy" | "other";
export type DryHopCalc = { grams: number; hopType: string; needsManualInput: boolean };

export function isDryHopAllowedForStyle(beerStyle: string | undefined | null): boolean {
    if (!beerStyle) return true;
    const s = beerStyle.trim();

    // "הופי לאגר" מכיל את "לאגר" שהוא ברשימת האסורים- בודקים "הופי" קודם
    if (s.includes("הופי")) return true;

    const disallowed = ["חיטה", "סטאוט", "לאגר"];
    if (disallowed.some((d) => s.includes(d))) return false;

    return true;
}

export function getDryHopStyleCategory(beerStyle: string | undefined | null): DryHopStyleCategory {
    if (!beerStyle) return "other";
    const s = beerStyle.trim();
    const lower = s.toLowerCase();

    if (lower.includes("ipa")) return "ipa";
    if (s.includes("פייל")) return "pale";
    if (s.includes("הופי")) return "hoppy";
    return "other";
}

export function calcDryHopDose(category: DryHopStyleCategory, beerVolume: number | string | null | undefined): DryHopCalc {
    const volume = Number(beerVolume) || 0;

    switch (category) {
        case "ipa": return { grams: 3 * volume, hopType: "Cascade", needsManualInput: false };
        case "pale": return { grams: 0.961 * volume, hopType: "Cascade", needsManualInput: false };
        case "hoppy": return { grams: 2 * volume, hopType: "Talos", needsManualInput: false };
        default: return { grams: 0, hopType: "", needsManualInput: true };
    }
}

export function roundGramsUp5(grams: number): number {
    return Math.ceil(grams / 5) * 5;
}

export function getClosingPressureForStyle(
    beerStyle: string | null | undefined,
    specs: SpecChart
): number | null {
    const pressureSpecs = specs?.pressure;
    if (!pressureSpecs) return null;

    const normalizedStyle = String(beerStyle || "").trim().toLowerCase().split(/\s+/)[0];
    const value = pressureSpecs[normalizedStyle] ?? pressureSpecs.other;

    return typeof value === "number" ? value : null;
}

export function buildDryHopNoteText(grams: number, hopType: string, closingPressure: number | string | null): string {
    const gramsText = grams > 0 ? grams.toFixed(0) : "0";
    const pressureText = closingPressure !== null && closingPressure !== "" ? String(closingPressure) : "—";
    return `הכנסת כשות 4. דרייהופ. ${gramsText} גרם של ${hopType}. סגירת לחץ, כיוון פורק ל${pressureText} bar`;
}