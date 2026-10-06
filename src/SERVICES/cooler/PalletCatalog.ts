import { collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../../firebase";
import type { Pallet } from "../cooler/Pallettypes ";

export type CatalogEntry = {
    sku: string;
    displayText: string;
};

export type ShipmentCatalogOption = CatalogEntry & {
    beerStyle: string;
    itemType: Pallet["itemType"];
};

export type EditableCatalogEntry = ShipmentCatalogOption & {
    id: string;
    styleKey: string;
    enabled: boolean;
};

const CATALOG_COLLECTION = "productCatalog";

function normalizeBeerStyleKey(beerStyle: string | undefined | null): string | null {
    if (!beerStyle) return null;
    const s = String(beerStyle).trim();
    const lower = s.toLocaleLowerCase("he-IL");

    if (s.includes("אגסים")) return "אגסים";
    if (s.includes("מהדורת חורף") || s.includes("בירת חורף")) return "מהדורת חורף";
    if (s.includes("הופי") && s.includes("לאגר")) return "הופי לאגר";
    if (s.includes("סשן") && /ipa/i.test(s)) return "סשן ipa";
    if (s.includes("דאבל") && /ipa/i.test(s)) return "דאבל ipa";
    if (s.includes("לאגר")) return "לאגר";
    if (s.includes("חיטה")) return "חיטה";
    if (s.includes("סטאוט")) return "סטאוט";
    if (s.includes("סאוור") || s.includes("סאואר")) return "סאוור";
    if (s.includes("פייל")) return "פייל אייל";
    if (/ipa/i.test(s)) return "ipa";

    return lower || null;
}

const DEFAULT_CATALOG: Record<string, EditableCatalogEntry> = {
    "אגסים__crates": { id: "אגסים__crates", styleKey: "אגסים", beerStyle: "אגסים", itemType: "crates", sku: "7014515", displayText: `שפירא אגסים ח"פ 330 בק' FARM TO BOTTLE`, enabled: true },
    "חיטה__kegs": { id: "חיטה__kegs", styleKey: "חיטה", beerStyle: "חיטה", itemType: "kegs", sku: "7009941", displayText: "שפירא חיטה 20 ליטר חבית", enabled: true },
    "חיטה__crates": { id: "חיטה__crates", styleKey: "חיטה", beerStyle: "חיטה", itemType: "crates", sku: "7009677", displayText: `שפירא חיטה ח"פ 330 בקבוק 24 יח'`, enabled: true },
    "לאגר__kegs": { id: "לאגר__kegs", styleKey: "לאגר", beerStyle: "לאגר", itemType: "kegs", sku: "7009942", displayText: "שפירא לאגר 20 ליטר חבית", enabled: true },
    "לאגר__crates": { id: "לאגר__crates", styleKey: "לאגר", beerStyle: "לאגר", itemType: "crates", sku: "7009678", displayText: `שפירא לאגר ח"פ 330 בקבוק 24 יח'`, enabled: true },
    "מהדורת חורף__crates": { id: "מהדורת חורף__crates", styleKey: "מהדורת חורף", beerStyle: "מהדורת חורף", itemType: "crates", sku: "7009876", displayText: `שפירא מהדורת חורף ח"פ 330 בקבוק 24 יח`, enabled: true },
    "הופי לאגר__kegs": { id: "הופי לאגר__kegs", styleKey: "הופי לאגר", beerStyle: "הופי לאגר", itemType: "kegs", sku: "7013781", displayText: "שפירא הופי לאגר (ניו לאגר) 20 ליטר חבית", enabled: true },
    "הופי לאגר__crates": { id: "הופי לאגר__crates", styleKey: "הופי לאגר", beerStyle: "הופי לאגר", itemType: "crates", sku: "7013782", displayText: `שפירא הופי לאגר(ניו לאגר) ח"פ 330 בקבוק 24 יח'`, enabled: true },
    "סאוור__crates": { id: "סאוור__crates", styleKey: "סאוור", beerStyle: "סאוור", itemType: "crates", sku: "7009682", displayText: `שפירא סאוור ח"פ 330 בקבוק 24 יח'`, enabled: true },
    "סטאוט__crates": { id: "סטאוט__crates", styleKey: "סטאוט", beerStyle: "סטאוט", itemType: "crates", sku: "7009679", displayText: `שפירא סטאוט ח"פ 330 בקבוק 24 יח'`, enabled: true },
    "סשן ipa__kegs": { id: "סשן ipa__kegs", styleKey: "סשן ipa", beerStyle: "סשן IPA", itemType: "kegs", sku: "7010951", displayText: "שפירא סשן IPA חבית 20 ליטר", enabled: true },
    "סשן ipa__crates": { id: "סשן ipa__crates", styleKey: "סשן ipa", beerStyle: "סשן IPA", itemType: "crates", sku: "7010892", displayText: `שפירא סשן IPA ח"פ בקבוק 330 24 יח'`, enabled: true },
    "פייל אייל__kegs": { id: "פייל אייל__kegs", styleKey: "פייל אייל", beerStyle: "פייל", itemType: "kegs", sku: "7009939", displayText: "שפירא פייל אייל 20 ליטר חבית", enabled: true },
    "פייל אייל__crates": { id: "פייל אייל__crates", styleKey: "פייל אייל", beerStyle: "פייל", itemType: "crates", sku: "7009670", displayText: `שפירא פייל אייל ח"פ 330 בקבוק 24 יח'`, enabled: true },
    "ipa__kegs": { id: "ipa__kegs", styleKey: "ipa", beerStyle: "IPA", itemType: "kegs", sku: "7009940", displayText: "שפירא IPA 20 ליטר חבית", enabled: true },
    "ipa__crates": { id: "ipa__crates", styleKey: "ipa", beerStyle: "IPA", itemType: "crates", sku: "7009676", displayText: `שפירא IPA ח"פ בקבוק 330 24 יח'`, enabled: true },
    "דאבל ipa__crates": { id: "דאבל ipa__crates", styleKey: "דאבל ipa", beerStyle: "דאבל IPA", itemType: "crates", sku: "7009681", displayText: `דאבל IPA ח"פ בקבוק 330 24 יח'`, enabled: true },
};

let overrides: Record<string, EditableCatalogEntry> = {};

function mergedCatalog(): Record<string, EditableCatalogEntry> {
    return { ...DEFAULT_CATALOG, ...overrides };
}

export function subscribeToProductCatalog(onChange?: () => void): () => void {
    return onSnapshot(collection(db, CATALOG_COLLECTION), (snapshot) => {
        const next: Record<string, EditableCatalogEntry> = {};
        snapshot.docs.forEach((catalogDoc) => {
            const data = catalogDoc.data();
            const itemType = data.itemType === "kegs" ? "kegs" : "crates";
            const styleKey = String(data.styleKey ?? catalogDoc.id.split("__")[0] ?? "").trim().toLocaleLowerCase("he-IL");
            if (!styleKey) return;
            const id = `${styleKey}__${itemType}`;
            next[id] = {
                id,
                styleKey,
                beerStyle: String(data.beerStyle ?? styleKey).trim(),
                itemType,
                sku: String(data.sku ?? "").trim(),
                displayText: String(data.displayText ?? "").trim(),
                enabled: data.enabled !== false,
            };
        });
        overrides = next;
        onChange?.();
    });
}

export function getEditableCatalogEntries(): EditableCatalogEntry[] {
    return Object.values(mergedCatalog()).sort(
        (a, b) => a.beerStyle.localeCompare(b.beerStyle, "he") || a.itemType.localeCompare(b.itemType),
    );
}

export async function saveCatalogEntry(entry: Omit<EditableCatalogEntry, "id">): Promise<void> {
    const styleKey = normalizeBeerStyleKey(entry.styleKey || entry.beerStyle);
    if (!styleKey) throw new Error("יש להזין סגנון בירה");
    if (!entry.sku.trim()) throw new Error('יש להזין מק"ט');
    if (!entry.displayText.trim()) throw new Error("יש להזין תיאור מוצר");
    const id = `${styleKey}__${entry.itemType}`;
    await setDoc(doc(db, CATALOG_COLLECTION, id), {
        styleKey,
        beerStyle: entry.beerStyle.trim(),
        itemType: entry.itemType,
        sku: entry.sku.trim(),
        displayText: entry.displayText.trim(),
        enabled: entry.enabled,
        updatedAt: serverTimestamp(),
    }, { merge: true });
}

export function getCatalogEntry(
    beerStyle: string | undefined | null,
    itemType: Pallet["itemType"]
): CatalogEntry | null {
    const key = normalizeBeerStyleKey(beerStyle);
    if (!key) return null;
    const entry = mergedCatalog()[`${key}__${itemType}`];
    return entry?.enabled ? { sku: entry.sku, displayText: entry.displayText } : null;
}

export function getPackagingCatalogOptions(beerStyle: string | undefined | null): ShipmentCatalogOption[] {
    const key = normalizeBeerStyleKey(beerStyle);
    if (!key) return [];
    return (["crates", "kegs"] as const).flatMap((itemType) => {
        const entry = mergedCatalog()[`${key}__${itemType}`];
        return entry?.enabled ? [{ sku: entry.sku, displayText: entry.displayText, beerStyle: entry.beerStyle, itemType }] : [];
    });
}

export function getShipmentCatalogOptions(): ShipmentCatalogOption[] {
    return Object.values(mergedCatalog())
        .filter((entry) => entry.enabled)
        .map(({ sku, displayText, beerStyle, itemType }) => ({ sku, displayText, beerStyle, itemType }))
        .sort((a, b) => a.displayText.localeCompare(b.displayText, "he"));
}
