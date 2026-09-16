import {
    doc,
    runTransaction,
    serverTimestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import type { ManualShipmentLine } from "./Pallettypes ";

const SHIPMENTS_COLLECTION = "shipments";

export async function createManualShipment(
    lines: ManualShipmentLine[],
    customerName?: string | null,
    customerId?: string | null,
): Promise<string> {
    const cleanCustomerName = customerName?.trim() || "";
    if (!cleanCustomerName) {
        throw new Error("יש להזין שם לקוח");
    }

    const cleanLines = lines
        .map((line) => ({
            ...line,
            sku: line.sku.trim(),
            description: line.description.trim(),
            quantity: Number(line.quantity),
        }))
        .filter((line) => line.description && Number.isFinite(line.quantity) && line.quantity > 0);

    if (!cleanLines.length) {
        throw new Error("יש להוסיף לפחות פריט אחד לתעודת המשלוח");
    }

    const counterRef = doc(db, "counters", "shipmentNumber");

    const shipmentNumber = await runTransaction(db, async (tx) => {
        const counterSnap = await tx.get(counterRef);
        const currentNumber = counterSnap.exists() ? Number(counterSnap.data().value) : 2389;

        if (!Number.isFinite(currentNumber)) {
            throw new Error("מונה תעודות המשלוח אינו תקין");
        }

        const nextNumber = currentNumber + 1;
        const shipmentRef = doc(db, SHIPMENTS_COLLECTION, String(nextNumber));

        tx.set(counterRef, { value: nextNumber }, { merge: true });
        tx.set(shipmentRef, {
            shipmentNumber: nextNumber,
            palletIds: [],
            totals: [],
            manualLines: cleanLines,
            sourceType: "manual",
            customerName: cleanCustomerName,
            customerId: customerId?.trim() || null,
            createdAt: serverTimestamp(),
        });

        return nextNumber;
    });

    return String(shipmentNumber);
}
