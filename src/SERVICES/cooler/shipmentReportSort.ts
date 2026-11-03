import type { Shipment } from "./Pallettypes ";

type ReportShipment = Pick<Shipment, "id" | "shipmentNumber" | "createdAt">;

function createdAtMillis(shipment: ReportShipment): number | null {
    const timestamp = shipment.createdAt;
    if (!timestamp) return null;
    const millis = timestamp.toMillis();
    return Number.isFinite(millis) ? millis : null;
}

/** Newest issued delivery notes first, with legacy missing dates at the end. */
export function sortShipmentReportsNewestFirst<T extends ReportShipment>(
    shipments: readonly T[],
): T[] {
    return [...shipments].sort((a, b) => {
        const aCreated = createdAtMillis(a);
        const bCreated = createdAtMillis(b);
        if (aCreated !== null && bCreated !== null && aCreated !== bCreated) {
            return bCreated - aCreated;
        }
        if (aCreated === null && bCreated !== null) return 1;
        if (aCreated !== null && bCreated === null) return -1;
        const numberDifference = Number(b.shipmentNumber) - Number(a.shipmentNumber);
        if (Number.isFinite(numberDifference) && numberDifference !== 0) return numberDifference;
        return b.id.localeCompare(a.id);
    });
}
