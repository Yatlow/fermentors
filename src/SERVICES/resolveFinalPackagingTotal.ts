import { getMeasurementsByBatch } from "./gettAllDataByBatch";
import type { Fermentor } from "../App";
import type { Measurement } from "./calculateCelleringRecomendations";

const KEG_LITERS = 20;
const BOTTLE_LITERS = 0.330;

const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

const LITERS_REGEX = /סה["״']?כ\s*([\d.]+)\s*ליטר/;

function sumPackagedLitersFromMeasurements(measurements: Measurement[]) {
    let total = 0;
    let entriesFound = 0;

    for (const m of measurements) {
        if (!m.notes) continue;
        const notesText = String(m.notes);
        const match = notesText.match(LITERS_REGEX);
        if (match) {
            const liters = Number(match[1]);
            if (Number.isFinite(liters)) {
                total += liters;
                entriesFound++;
            }
        }
    }

    return { total, entriesFound };
}

async function fetchLegacyCellLiters(
    sheetUrl: string,
    cellType: "kegs" | "crates"
): Promise<number | null> {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
            action: "checkLegacyPackagingCell",
            sheetUrl,
            cellType,
        }),
    });

    const text = await response.text();
    let parsed: { success: boolean; result?: { rawValue?: number }; error?: string };

    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (!parsed.success || parsed.result?.rawValue === undefined) return null;

    const rawValue = Number(parsed.result.rawValue);
    if (!Number.isFinite(rawValue)) return null;

    return cellType === "kegs" ? rawValue * KEG_LITERS : rawValue * BOTTLE_LITERS;
}

export async function resolveFinalPackagingTotal(
    packagingType: "kegs" | "bottles" | "",
    tank: Fermentor,
    reportLiters: number
): Promise<{ totalLiters: number; shrinkagePercent: number | null }> {

    const measurements = await getMeasurementsByBatch(tank.batchNumber ?? "");
    const { total: historicalTotal, entriesFound } =
        sumPackagedLitersFromMeasurements(measurements);

    let totalLiters = historicalTotal + reportLiters;

    const beerVolume = Number(tank.beerVolume);
    let shrinkagePercent =
        Number.isFinite(beerVolume) && beerVolume > 0
            ? ((totalLiters - beerVolume) / beerVolume) * 100
            : null;

    // Fallback לשרת - רק אם אין תוצאה ב-Firebase והפחת חריג
    if (
        entriesFound === 0 &&
        shrinkagePercent !== null &&
        shrinkagePercent <10 &&
        tank.sheetUrl
    ) {
        const oppositeType: "kegs" | "crates" =
            packagingType === "kegs" ? "crates" : "kegs";

        const legacyLiters = await fetchLegacyCellLiters(tank.sheetUrl, oppositeType);

        if (legacyLiters !== null && legacyLiters > 0) {
            totalLiters += legacyLiters;
            shrinkagePercent =
                Number.isFinite(beerVolume) && beerVolume > 0
                    ? ((totalLiters - beerVolume) / beerVolume) * 100
                    : null;
        }
    }

    return { totalLiters, shrinkagePercent };
}