import type { Pallet, PalletItemType, Shipment } from "../cooler/Pallettypes ";
import { buildShipmentTraceability, type CatalogLookup, type ShipmentLotRow } from "./shipmentTraceability";

/** A read-only view: no extra Firestore collections, indexes or persisted report copies. */
export type BatchShipmentRow = ShipmentLotRow & {
    shipmentId: string;
    shipmentNumber: number;
    shipmentDate: Date | null;
    customerName: string;
};

export type BatchStockRow = {
    sku: string;
    description: string;
    itemType: PalletItemType;
    expiryDateStr: string | null;
    quantity: number;
    zones: Record<string, number>;
};

export type BatchSkuSummary = {
    sku: string;
    description: string;
    itemType: PalletItemType | null;
    shipped: number;
    remaining: number;
};

export type BatchTraceability = {
    batchNumber: string;
    shipments: BatchShipmentRow[];
    stock: BatchStockRow[];
    summaries: BatchSkuSummary[];
    missingHistoricalPallets: number;
    hasUnverifiedShipments: boolean;
};

const activeZones = new Set(["cooler", "pending", "bottleRoom", "loadingDock"]);
const clean = (value: unknown) => String(value ?? "").trim();
const quantityOf = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

function skuKey(sku: string, itemType: PalletItemType | null): string {
    return JSON.stringify([sku, itemType]);
}

/** Includes lots still in stock and those present only in past shipment records. */
export function listTraceableBatches(shipments: Shipment[], pallets: Pallet[]): string[] {
    const lots = new Set<string>();
    for (const pallet of pallets) {
        if (clean(pallet.batchNumber)) lots.add(clean(pallet.batchNumber));
    }
    for (const shipment of shipments) {
        for (const row of shipment.palletSnapshot ?? []) {
            if (clean(row.batchNumber)) lots.add(clean(row.batchNumber));
        }
        for (const row of shipment.manualLines ?? []) {
            if (clean(row.batchNumber)) lots.add(clean(row.batchNumber));
        }
    }
    return [...lots].sort((a, b) => b.localeCompare(a, "he", { numeric: true }));
}

/** Shipments are the source of shipped quantities, and active pallets are the source of stock.
 * Never infer remaining stock as production minus shipments; damaged/adjusted stock may exist.
 */
export function buildBatchTraceability(
    batchNumber: string,
    shipments: Shipment[],
    pallets: Pallet[],
    catalog: CatalogLookup,
): BatchTraceability {
    const selected = clean(batchNumber);
    const palletsById = new Map(pallets.map((p) => [p.id, p]));
    const shippedRows: BatchShipmentRow[] = [];
    const stockRows = new Map<string, BatchStockRow>();
    const summary = new Map<string, BatchSkuSummary>();
    let missingHistoricalPallets = 0;
    let hasUnverifiedShipments = false;

    const addSummary = (sku: string, description: string, itemType: PalletItemType | null, key: "shipped" | "remaining", quantity: number) => {
        const id = skuKey(sku, itemType);
        const current = summary.get(id) ?? { sku, description, itemType, shipped: 0, remaining: 0 };
        current[key] += quantity;
        summary.set(id, current);
    };

    for (const shipment of shipments) {
        const available = (shipment.palletIds ?? []).map((id) => palletsById.get(id)).filter((p): p is Pallet => Boolean(p));
        const detail = buildShipmentTraceability(shipment, available, catalog);
        missingHistoricalPallets += detail.missingPallets;
        const matched = detail.rows.filter((row) => selected && clean(row.batchNumber) === selected);
        if (matched.length === 0) continue;
        if (detail.hasUnverifiedData) hasUnverifiedShipments = true;
        for (const row of matched) {
            const date = shipment.createdAt?.toDate?.() ?? null;
            shippedRows.push({
                ...row,
                shipmentId: shipment.id,
                shipmentNumber: shipment.shipmentNumber,
                shipmentDate: date,
                customerName: clean(shipment.customerName) || "לקוח לא ידוע",
            });
            addSummary(row.sku, row.description, row.itemType, "shipped", row.quantity);
        }
    }

    for (const pallet of pallets) {
        if (!selected || clean(pallet.batchNumber) !== selected || !activeZones.has(pallet.zone)) continue;
        const qty = quantityOf(pallet.quantity);
        if (qty <= 0) continue;
        const entry = catalog(clean(pallet.beerStyle), pallet.itemType);
        const sku = entry?.sku || "—";
        const description = entry?.displayText || clean(pallet.beerStyle);
        const expiryDateStr = clean(pallet.expiryDateStr) || null;
        const id = JSON.stringify([sku, pallet.itemType, expiryDateStr]);
        const stock = stockRows.get(id) ?? {
            sku, description, itemType: pallet.itemType,
            expiryDateStr, quantity: 0, zones: {},
        };
        stock.quantity += qty;
        stock.zones[pallet.zone] = (stock.zones[pallet.zone] ?? 0) + qty;
        stockRows.set(id, stock);
        addSummary(sku, description, pallet.itemType, "remaining", qty);
    }

    return {
        batchNumber: selected,
        shipments: shippedRows.sort((a, b) =>
            (b.shipmentDate?.getTime() ?? 0) - (a.shipmentDate?.getTime() ?? 0) ||
            b.shipmentNumber - a.shipmentNumber),
        stock: [...stockRows.values()].sort((a, b) => a.sku.localeCompare(b.sku) ||
            (a.expiryDateStr ?? "").localeCompare(b.expiryDateStr ?? "")),
        summaries: [...summary.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
        missingHistoricalPallets,
        hasUnverifiedShipments,
    };
}
