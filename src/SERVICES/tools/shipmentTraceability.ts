import type { Pallet, PalletItemType, Shipment, ShipmentPalletSnapshot } from "../cooler/Pallettypes ";

export type ShipmentLotRow = {
    sku: string;
    description: string;
    itemType: PalletItemType | null;
    batchNumber: string | null;
    expiryDateStr: string | null;
    quantity: number;
    unverified: boolean;
};

export type ShipmentTraceability = {
    rows: ShipmentLotRow[];
    missingPallets: number;
    hasUnverifiedData: boolean;
    warnings: string[];
};

export type CatalogLookup = (beerStyle: string, itemType: PalletItemType) =>
    { sku: string; displayText: string } | null;

const clean = (value: unknown): string => String(value ?? "").trim();
const validQty = (value: unknown): number => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
};

export function buildShipmentTraceability(
    shipment: Shipment,
    availablePallets: Pallet[],
    catalog: CatalogLookup,
): ShipmentTraceability {
    const rows = new Map<string, ShipmentLotRow>();
    const warnings: string[] = [];
    let missingPallets = 0;

    const add = (row: ShipmentLotRow) => {
        if (row.quantity <= 0) return;
        const key = JSON.stringify([
            row.sku, row.description, row.itemType, row.batchNumber,
            row.expiryDateStr, row.unverified,
        ]);
        const previous = rows.get(key);
        if (previous) previous.quantity += row.quantity;
        else rows.set(key, { ...row });
    };

    if (shipment.sourceType === "manual" || (shipment.manualLines?.length ?? 0) > 0) {
        for (const line of shipment.manualLines ?? []) {
            add({
                sku: clean(line.sku) || "—",
                description: clean(line.description) || "פריט ללא תיאור",
                itemType: null,
                batchNumber: clean(line.batchNumber) || null,
                expiryDateStr: clean(line.expiryDateStr) || null,
                quantity: validQty(line.quantity),
                unverified: !clean(line.batchNumber) || !clean(line.expiryDateStr),
            });
        }
        if ([...rows.values()].some((row) => row.unverified)) {
            warnings.push("בתעודה ידנית זו לא דווחו פרטי אצווה או תפוגה לחלק מהפריטים.");
        }
    } else {
        // New shipments have an immutable shipment-time snapshot. Old notes fall back
        // to surviving pallet documents; they must never look more certain than they are.
        const hasSnapshot = Array.isArray(shipment.palletSnapshot);
        const pallets: Array<Pallet | ShipmentPalletSnapshot> = hasSnapshot
            ? shipment.palletSnapshot ?? []
            : availablePallets;
        const found = new Set(pallets.map((p) => "palletId" in p ? p.palletId : p.id));
        missingPallets = (shipment.palletIds ?? []).filter((id) => !found.has(id)).length;
        if (missingPallets > 0) {
            warnings.push(hasSnapshot
                ? "חסרות בתמונת המשטחים השמורה " + missingPallets + " רשומות מתעודת המשלוח; עקיבות המשלוח אינה שלמה."
                : "לא נמצאו " + missingPallets + " משטחים מתעודה ישנה; פירוט האצוות שלהם אינו זמין.");
        }
        if (!hasSnapshot && shipment.palletIds?.length && !availablePallets.length) {
            warnings.push("לא ניתן לאמת את נתוני האצווה והתפוגה של תעודה זו.");
        }

        const observedTotals = new Map<string, number>();
        for (const pallet of pallets) {
            const itemType = pallet.itemType;
            const beerStyle = clean(pallet.beerStyle);
            const entry = catalog(beerStyle, itemType);
            const stored = pallet as ShipmentPalletSnapshot;
            const sku = clean(stored.sku) || entry?.sku || "—";
            const description = clean(stored.description) || entry?.displayText ||
                (beerStyle + " (" + (itemType === "kegs" ? "חביות" : "ארגזים") + ")");
            const quantity = validQty(pallet.quantity);
            const batchNumber = clean(pallet.batchNumber) || null;
            const expiryDateStr = clean(pallet.expiryDateStr) || null;
            const key = JSON.stringify([beerStyle, itemType]);
            observedTotals.set(key, (observedTotals.get(key) ?? 0) + quantity);
            add({
                sku, description, itemType, batchNumber, expiryDateStr, quantity,
                unverified: !batchNumber || !expiryDateStr,
            });
        }

        // Preserve the shipped total on older documents when some source pallets
        // no longer exist. Unknown quantities are explicitly separated by SKU.
        for (const total of shipment.totals ?? []) {
            const key = JSON.stringify([clean(total.beerStyle), total.itemType]);
            const expected = validQty(total.totalQuantity);
            const observed = observedTotals.get(key) ?? 0;
            if (hasSnapshot && observed === expected) continue;
            if (observed > expected) {
                warnings.push("כמות משטחים קיימת גדולה מהכמות המקורית עבור " + total.beerStyle + ".");
            } else if (expected > observed) {
                // A saved shipment-time snapshot is authoritative for what was
                // recorded, but it can itself be INCOMPLETE. Never silently
                // accept a deficit merely because this is a newer document.
                const missing = expected - observed;
                const entry = catalog(clean(total.beerStyle), total.itemType);
                add({
                    sku: entry?.sku || "—",
                    description: entry?.displayText || clean(total.beerStyle),
                    itemType: total.itemType,
                    batchNumber: null, expiryDateStr: null,
                    quantity: missing,
                    unverified: true,
                });
                warnings.push("בתעודת המשלוח חסרות " + missing +
                    " יחידות " + total.beerStyle +
                    " ללא אצווה מאומתת; הכמות בדוח אינה תואמת את תמונת המשטחים.");
            }
        }
    }

    const result = [...rows.values()].sort((a, b) =>
        a.sku.localeCompare(b.sku, "he") ||
        (a.batchNumber ?? "").localeCompare(b.batchNumber ?? "", "he") ||
        (a.expiryDateStr ?? "").localeCompare(b.expiryDateStr ?? "", "he")
    );
    return {
        rows: result,
        missingPallets,
        hasUnverifiedData: result.some((row) => row.unverified) || missingPallets > 0 || warnings.length > 0,
        warnings: [...new Set(warnings)],
    };
}

export function displayShipmentExpiry(value: string | null): string {
    if (!value) return "לא ידוע";
    const s = value.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (iso) return iso[3] + "/" + iso[2] + "/" + iso[1];
    return s;
}
