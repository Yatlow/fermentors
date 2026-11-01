import type { SpecChart } from "../getAndPost/getSpecsFromFb";

/** Maximum final gravity (°P) for a completed fermentation, by style. */
export const DEFAULT_FERMENTATION_END_PLATO: Record<string, number> = {
    "חיטה": 2.7,
    "לאגר": 2.6,
    "הופי": 2.6,
    "פייל": 2.8,
    ipa: 3.6,
    "סטאוט": 4.1,
};

export const WINTER_CARBONATION_TARGET = 2.3;

/** Hoppy lager shares the lager's finish threshold; winter has no defined threshold. */
export function fermentationEndStyleKey(beerStyle: string | number | null | undefined): string | null {
    const name = String(beerStyle ?? "").trim().toLowerCase();
    if (!name) return null;
    if (/\bipa\b/.test(name)) return "ipa";
    if (name.includes("חיטה") || name.includes("wheat")) return "חיטה";
    if (name.includes("סטאוט") || name.includes("stout")) return "סטאוט";
    if (name.includes("פייל") || name.includes("pale")) return "פייל";
    if ((name.includes("הופי") && name.includes("לאגר")) || (name.includes("hoppy") && name.includes("lager"))) return "הופי";
    if (name.includes("לאגר") || name.includes("lager")) return "לאגר";
    return null;
}

export function getFermentationEndPlatoLimit(
    beerStyle: string | number | null | undefined,
    specs: SpecChart,
): number | null {
    const key = fermentationEndStyleKey(beerStyle);
    if (!key) return null;
    const override = specs.fermentationEndPlato?.[key];
    return typeof override === "number" && Number.isFinite(override) && override >= 0
        ? override
        : DEFAULT_FERMENTATION_END_PLATO[key];
}

/** Winter can be entered as either "חורף", "בירת חורף" or "winter". */
export function carbonationSpecKey(beerStyle: string | number | null | undefined): string {
    const style = String(beerStyle ?? "").trim().toLowerCase();
    return /חורף|winter/.test(style) ? "חורף" : style.split(/\s+/)[0];
}
