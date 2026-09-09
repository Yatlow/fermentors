import type { Pallet } from "../cooler/Pallettypes ";

export type CatalogEntry = {
    sku: string;
    displayText: string;
};

type NormalizedStyleKey =
    | "אגסים"
    | "חיטה"
    | "לאגר"
    | "מהדורת חורף"
    | "הופי לאגר"
    | "סאוור"
    | "סטאוט"
    | "סשן ipa"
    | "פייל אייל"
    | "ipa"
    | "דאבל ipa";

/**
 * ממפה מחרוזת beerStyle חופשית (כפי שנשמרת בפועל על המשטח) לקטגוריה קבועה בקטלוג.
 * הסדר קריטי: בדיקות ספציפיות (סשן IPA, דאבל IPA, הופי לאגר) חייבות לקרות
 * *לפני* הבדיקות הכלליות (IPA, לאגר) - אחרת "סשן IPA" ייפול בטעות ל"IPA" הרגיל.
 */
function normalizeBeerStyleKey(beerStyle: string | undefined | null): NormalizedStyleKey | null {
    if (!beerStyle) return null;
    const s = String(beerStyle).trim();

    if (s.includes("אגסים")) return "אגסים";
    if (s.includes("מהדורת חורף")) return "מהדורת חורף";
    if (s.includes("הופי") && s.includes("לאגר")) return "הופי לאגר";
    if (s.includes("סשן") && /ipa/i.test(s)) return "סשן ipa";
    if (s.includes("דאבל") && /ipa/i.test(s)) return "דאבל ipa";
    if (s.includes("לאגר")) return "לאגר";
    if (s.includes("חיטה")) return "חיטה";
    if (s.includes("סטאוט")) return "סטאוט";
    if (s.includes("סאוור") || s.includes("סאואר")) return "סאוור";
    if (s.includes("פייל")) return "פייל אייל";
    if (/ipa/i.test(s)) return "ipa";

    return null;
}

// המפתח: `${normalizedStyleKey}__${itemType}`
const PALLET_CATALOG: Record<string, CatalogEntry> = {
    "אגסים__crates": { sku: "7014515", displayText: `שפירא אגסים ח"פ 330 בק' FARM TO BOTTLE` },

    "חיטה__kegs": { sku: "7009941", displayText: `שפירא חיטה 20 ליטר חבית` },
    "חיטה__crates": { sku: "7009677", displayText: `שפירא חיטה ח"פ 330 בקבוק 24 יח'` },

    "לאגר__kegs": { sku: "7009942", displayText: `שפירא לאגר 20 ליטר חבית` },
    "לאגר__crates": { sku: "7009678", displayText: `שפירא לאגר ח"פ 330 בקבוק 24 יח'` },

    "מהדורת חורף__crates": { sku: "7009876", displayText: `שפירא מהדורת חורף ח"פ 330 בקבוק 24 יח` },

    "הופי לאגר__kegs": { sku: "7013781", displayText: `שפירא הופי לאגר (ניו לאגר) 20 ליטר חבית` },
    "הופי לאגר__crates": { sku: "7013782", displayText: `שפירא הופי לאגר(ניו לאגר) ח"פ 330 בקבוק 24 יח'` },

    "סאוור__crates": { sku: "7009682", displayText: `שפירא סאוור ח"פ 330 בקבוק 24 יח'` },

    "סטאוט__crates": { sku: "7009679", displayText: `שפירא סטאוט ח"פ 330 בקבוק 24 יח'` },

    "סשן ipa__kegs": { sku: "7010951", displayText: `שפירא סשן IPA חבית 20 ליטר` },
    "סשן ipa__crates": { sku: "7010892", displayText: `שפירא סשן IPA ח"פ בקבוק 330 24 יח'` },

    "פייל אייל__kegs": { sku: "7009939", displayText: `שפירא פייל אייל 20 ליטר חבית` },
    "פייל אייל__crates": { sku: "7009670", displayText: `שפירא פייל אייל ח"פ 330 בקבוק 24 יח'` },

    "ipa__kegs": { sku: "7009940", displayText: `שפירא IPA 20 ליטר חבית` },
    "ipa__crates": { sku: "7009676", displayText: `שפירא IPA ח"פ בקבוק 330 24 יח'` },

    "דאבל ipa__crates": { sku: "7009681", displayText: `דאבל IPA ח"פ בקבוק 330 24 יח'` },
};

export function getCatalogEntry(
    beerStyle: string | undefined | null,
    itemType: Pallet["itemType"]
): CatalogEntry | null {
    const key = normalizeBeerStyleKey(beerStyle);
    if (!key) return null;
    return PALLET_CATALOG[`${key}__${itemType}`] ?? null;
}