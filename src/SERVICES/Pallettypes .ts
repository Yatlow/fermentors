export type PalletItemType = "kegs" | "crates";

export type CoolerSide = "right" | "left" | "corridor";

export type CoolerCell = {
    side: CoolerSide;
    col: number;
    row: number;
};

export type Pallet = {
    id: string;
    beerStyle: string;
    itemType: PalletItemType;
    quantity: number;
    subLabel?: string | null;
    expiryDateStr?: string | null;
    zone: PalletZone;
    cell?: CoolerCell | null;
    orderInCell?: number | null;
    // נשמר לתאימות לאחור עם מסמכים ישנים.
    cellOrder?: number;
    slotIndex?: number | null;
    heightUnits: number;
    markedForShipment?: boolean;
    batchNumber?: string | null;
    palletNumber?: string | null;
    sourceTankNumber?: string | number | null;
};

export type PalletZone = "cooler" | "pending" | "bottleRoom" | "loadingDock" ;

export const MAX_CRATES_PER_PALLET = 84;
export const MAX_KEGS_PER_PALLET = 20;
export const MAX_HEIGHT_UNITS_PER_CELL = 5;
export const MAX_HEIGHT_UNITS_PER_LOADING_PALLET = 4;

export function calcHeightUnits(itemType: PalletItemType, quantity: number): number {
    if (itemType === "kegs") return 1;
    if (quantity <= 24) return 1;
    if (quantity <= 48) return 1.6;
    return 2.35;
}

type StyleCategory = "ipa" | "pale" | "lager" | "hoppyLager" | "wheat" | "stout" | "sour" | "other";

const STYLE_PATTERNS: { category: StyleCategory; test: RegExp; displayLabel: string }[] = [
    { category: "ipa", test: /ipa/i, displayLabel: "IPA" },
    { category: "pale", test: /פייל/, displayLabel: "פייל" },
    { category: "hoppyLager", test: /הופי.*לאגר/, displayLabel: "הופי לאגר" },
    { category: "lager", test: /לאגר/, displayLabel: "לאגר" },
    { category: "wheat", test: /חיטה/, displayLabel: "חיטה" },
    { category: "stout", test: /סטאוט/, displayLabel: "סטאוט" },
    { category: "sour", test: /סאוט|sour/i, displayLabel: "סאואר" },
];

export function beerStyleClass(rawStyle: string): { className: string; category: StyleCategory; displayLabel: string } {
    const match = STYLE_PATTERNS.find((p) => p.test.test(rawStyle));
    if (match) return { className: `pallet-style-${match.category}`, category: match.category, displayLabel: match.displayLabel };
    return { className: "pallet-style-other", category: "other", displayLabel: rawStyle };
}
