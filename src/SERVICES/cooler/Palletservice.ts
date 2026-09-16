import { calcTruckSlots, MAX_TRUCK_SLOTS, MAX_TRUCK_HEIGHT_CM } from "./truckCapacity";
export { calcTruckSlots, MAX_TRUCK_SLOTS, MAX_TRUCK_HEIGHT_CM };
import {
    collection,
    doc,
    updateDoc,
    onSnapshot,
    query,
    where,
    runTransaction,
    writeBatch,
    serverTimestamp,
    getCountFromServer,
    getDocsFromServer,
} from "firebase/firestore";
import { db } from "../../firebase";
import {
    calcHeightCm,
    MAX_CRATES_PER_PALLET,
    MAX_KEGS_PER_PALLET,
    type Pallet,
    type PalletItemType,
    type PalletZone,
    type CoolerCell,
} from "./Pallettypes ";

const PALLETS_COLLECTION = "pallets";
const SHIPMENTS_COLLECTION = "shipments";

export type ShipmentCustomerOption = {
    name: string;
    customerId: string | null;
};

function customerKey(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("he-IL");
}

export async function getShipmentCustomerSuggestions(): Promise<ShipmentCustomerOption[]> {
    const snapshot = await getDocsFromServer(collection(db, SHIPMENTS_COLLECTION));
    const options = new Map<string, ShipmentCustomerOption>();
    options.set(customerKey("טמפו"), { name: "טמפו", customerId: "tempo" });
    snapshot.docs.forEach((shipment) => {
        const data = shipment.data();
        const name = String(data.customerName ?? "").trim().replace(/\s+/g, " ");
        if (!name) return;
        const id = typeof data.customerId === "string" && data.customerId.trim() ? data.customerId.trim() : null;
        const canonicalName = id === "tempo" ? "טמפו" : name;
        const key = customerKey(canonicalName);
        const existing = options.get(key);
        if (!existing || (!existing.customerId && id)) options.set(key, { name: canonicalName, customerId: id });
    });
    return [...options.values()].sort((a, b) => {
        if (a.customerId === "tempo") return -1;
        if (b.customerId === "tempo") return 1;
        return a.name.localeCompare(b.name, "he");
    });
}

export type CreatePalletsParams = {
    itemType: PalletItemType;
    totalQuantity: number;
    beerStyle: string;
    batchNumber: string | number | null | undefined;
    expiryDateStr: string;
    sourceTankNumber: string | number | null | undefined;
};

function splitQuantity(totalQuantity: number, maxPerPallet: number): number[] {
    const chunks: number[] = [];
    let remaining = Math.round(totalQuantity);
    while (remaining > 0) {
        const chunk = Math.min(maxPerPallet, remaining);
        chunks.push(chunk);
        remaining -= chunk;
    }
    return chunks;
}

function maxPerPalletFor(itemType: PalletItemType): number {
    return itemType === "kegs" ? MAX_KEGS_PER_PALLET : MAX_CRATES_PER_PALLET;
}

function palletCreateData(input: {
    itemType: PalletItemType;
    beerStyle: string;
    subLabel?: string | null;
    quantity: number;
    expiryDateStr?: string | null;
    batchNumber?: string | null;
    sourceTankNumber?: string | number | null;
}) {
    return {
        itemType: input.itemType,
        beerStyle: input.beerStyle,
        subLabel: input.subLabel ?? null,
        quantity: input.quantity,
        heightCm: calcHeightCm(input.itemType, input.quantity),
        expiryDateStr: input.expiryDateStr ?? null,
        batchNumber: input.batchNumber ?? null,
        sourceTankNumber: input.sourceTankNumber ?? null,
        markedForShipment: false,
        zone: "pending" as PalletZone,
        cell: null,
        slotIndex: null,
        orderInCell: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    };
}

export async function createPalletsFromPackaging(params: CreatePalletsParams): Promise<string[]> {
    const { itemType, totalQuantity, beerStyle, batchNumber, expiryDateStr, sourceTankNumber } = params;
    if (!totalQuantity || totalQuantity <= 0) return [];
    const maxPerPallet = maxPerPalletFor(itemType);
    const quantities = splitQuantity(totalQuantity, maxPerPallet);
    const batch = writeBatch(db);
    const ids: string[] = [];
    quantities.forEach((quantity) => {
        const ref = doc(collection(db, PALLETS_COLLECTION));
        ids.push(ref.id);
        batch.set(ref, palletCreateData({ itemType, beerStyle, quantity, batchNumber: batchNumber == null ? null : String(batchNumber), expiryDateStr, sourceTankNumber }));
    });
    await batch.commit();
    return ids;
}

export type CustomPalletSplitEntry = { quantity: number; subLabel?: string | null };

export function getDefaultPalletSplit(itemType: PalletItemType, totalQuantity: number): CustomPalletSplitEntry[] {
    if (!totalQuantity || totalQuantity <= 0) return [];
    const maxPerPallet = maxPerPalletFor(itemType);
    return splitQuantity(totalQuantity, maxPerPallet).map((quantity) => ({ quantity, subLabel: null }));
}

export function getMaxQuantityPerPallet(itemType: PalletItemType): number {
    return maxPerPalletFor(itemType);
}

export type CreatePalletsFromCustomSplitParams = {
    itemType: PalletItemType;
    expectedTotalQuantity: number;
    beerStyle: string;
    batchNumber: string | number | null | undefined;
    expiryDateStr: string;
    sourceTankNumber: string | number | null | undefined;
    splits: CustomPalletSplitEntry[];
};

export async function createPalletsFromCustomSplit(params: CreatePalletsFromCustomSplitParams): Promise<string[]> {
    const { itemType, expectedTotalQuantity, beerStyle, batchNumber, expiryDateStr, sourceTankNumber, splits } = params;
    const expectedTotal = Math.round(expectedTotalQuantity);
    if (!expectedTotal || expectedTotal <= 0) return [];
    const sanitized = splits.map((s) => ({ quantity: Math.round(s.quantity), subLabel: s.subLabel?.trim() || null })).filter((s) => s.quantity > 0);
    if (sanitized.length === 0) throw new Error("יש להזין לפחות משטח אחד עם כמות גדולה מ-0");
    const actualTotal = sanitized.reduce((sum, s) => sum + s.quantity, 0);
    if (actualTotal !== expectedTotal) {
        const unit = itemType === "kegs" ? "חביות" : "ארגזים";
        throw new Error(`סך כל המשטחים (${actualTotal} ${unit}) לא תואם לכמות שדווחה בפועל (${expectedTotal} ${unit}). יש לתקן את החלוקה כך שהסכום יהיה זהה.`);
    }
    const maxPerPallet = maxPerPalletFor(itemType);
    const overLimit = sanitized.find((s) => s.quantity > maxPerPallet);
    if (overLimit) {
        const unit = itemType === "kegs" ? "חביות" : "ארגזים";
        throw new Error(`משטח בודד יכול להכיל עד ${maxPerPallet} ${unit} (נמצא משטח עם ${overLimit.quantity})`);
    }
    const palletBatch = writeBatch(db);
    const ids: string[] = [];
    sanitized.forEach((entry) => {
        const palletRef = doc(collection(db, PALLETS_COLLECTION));
        ids.push(palletRef.id);
        palletBatch.set(palletRef, palletCreateData({ itemType, beerStyle, subLabel: entry.subLabel ?? null, quantity: entry.quantity, expiryDateStr: expiryDateStr || null, batchNumber: batchNumber == null ? null : String(batchNumber), sourceTankNumber: sourceTankNumber ?? null }));
    });
    await palletBatch.commit();
    return ids;
}

export function subscribeToZone(zone: PalletZone, cb: (pallets: Pallet[]) => void) {
    const q = query(collection(db, PALLETS_COLLECTION), where("zone", "==", zone));
    return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Pallet))), (err) => console.error(`subscribeToZone(${zone}) error:`, err));
}

export async function updatePallet(palletId: string, input: { itemType: PalletItemType; beerStyle: string; subLabel?: string | null; quantity: number; expiryDateStr?: string | null; batchNumber?: string | null }) {
    if (!input.beerStyle.trim()) throw new Error("יש להזין סגנון בירה");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("כמות חייבת להיות גדולה מ-0");
    const max = maxPerPalletFor(input.itemType);
    if (input.quantity > max) throw new Error(`משטח בודד יכול להכיל עד ${max} ${input.itemType === "kegs" ? "חביות" : "ארגזים"}`);
    await updateDoc(doc(db, PALLETS_COLLECTION, palletId), { itemType: input.itemType, beerStyle: input.beerStyle.trim(), subLabel: input.subLabel?.trim() || null, quantity: Math.round(input.quantity), heightCm: calcHeightCm(input.itemType, Math.round(input.quantity)), expiryDateStr: input.expiryDateStr?.trim() || null, batchNumber: input.batchNumber?.trim() || null, updatedAt: serverTimestamp() });
}

export async function updatePalletQuantity(palletId: string, quantity: number) {
    const nextQuantity = Math.round(quantity);
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) throw new Error("כמות חייבת להיות גדולה מ-0");
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("המשטח לא נמצא");
        const pallet = snap.data() as Pallet;
        const max = maxPerPalletFor(pallet.itemType);
        if (nextQuantity > max) throw new Error(`משטח בודד יכול להכיל עד ${max} ${pallet.itemType === "kegs" ? "חביות" : "ארגזים"}`);
        tx.update(ref, { quantity: nextQuantity, heightCm: calcHeightCm(pallet.itemType, nextQuantity), updatedAt: serverTimestamp() });
    });
}

export async function deletePallet(palletId: string): Promise<void> {
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => { const snap = await tx.get(ref); if (!snap.exists()) throw new Error("המשטח כבר לא קיים"); tx.delete(ref); });
}

export async function splitPallet(palletId: string, splitQty: number, splitLabel: string | null) {
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    const newRef = doc(collection(db, PALLETS_COLLECTION));
    const quantityToSplit = Math.round(splitQty);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("המשטח לא נמצא");
        const pallet = { id: snap.id, ...(snap.data() as any) } as Pallet;
        if (quantityToSplit <= 0 || quantityToSplit >= pallet.quantity) throw new Error("כמות הפיצול חייבת להיות בין 1 לכמות פחות 1");
        const remainingQty = pallet.quantity - quantityToSplit;
        tx.update(ref, { quantity: remainingQty, heightCm: calcHeightCm(pallet.itemType, remainingQty), updatedAt: serverTimestamp() });
        tx.set(newRef, palletCreateData({ itemType: pallet.itemType, beerStyle: pallet.beerStyle, subLabel: splitLabel ?? pallet.subLabel ?? null, quantity: quantityToSplit, expiryDateStr: pallet.expiryDateStr ?? null, batchNumber: pallet.batchNumber ?? null, sourceTankNumber: pallet.sourceTankNumber ?? null }));
    });
}

export async function reorderPalletsInCell(orderedPalletIds: string[]) {
    const batch = writeBatch(db);
    orderedPalletIds.forEach((id, index) => batch.update(doc(db, PALLETS_COLLECTION, id), { orderInCell: index, slotIndex: index, updatedAt: serverTimestamp() }));
    await batch.commit();
}

export async function createPallet(input: { itemType: PalletItemType; beerStyle: string; subLabel?: string | null; quantity: number; expiryDateStr?: string | null; batchNumber?: string | null }): Promise<string> {
    const ids = await createPallets({ ...input, palletCount: 1 });
    return ids[0];
}

export async function createPallets(input: { itemType: PalletItemType; beerStyle: string; subLabel?: string | null; quantity: number; palletCount?: number; expiryDateStr?: string | null; batchNumber?: string | null }): Promise<string[]> {
    if (!input.beerStyle.trim()) throw new Error("יש להזין סגנון בירה");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("כמות חייבת להיות גדולה מ-0");
    const max = maxPerPalletFor(input.itemType);
    const totalModeChunks = splitQuantity(input.quantity, max);
    const chunks = input.palletCount && input.palletCount > 1 ? Array.from({ length: Math.floor(input.palletCount) }, () => input.quantity) : totalModeChunks;
    if (chunks.some((q) => q > max)) throw new Error(`משטח בודד יכול להכיל עד ${max} ${input.itemType === "kegs" ? "חביות" : "ארגזים"}`);
    const batch = writeBatch(db);
    const ids: string[] = [];
    chunks.forEach((quantity) => { const ref = doc(collection(db, PALLETS_COLLECTION)); ids.push(ref.id); batch.set(ref, palletCreateData({ ...input, quantity })); });
    await batch.commit();
    return ids;
}

export async function createShipment(palletIds: string[], customerName?: string | null, customerId?: string | null): Promise<string> {
    const uniquePalletIds = [...new Set(palletIds.filter(Boolean))];
    if (uniquePalletIds.length === 0) throw new Error("לא נבחרו משטחים למשלוח");
    if (uniquePalletIds.length !== palletIds.length) throw new Error("רשימת המשטחים מכילה כפילויות");
    const counterRef = doc(db, "counters", "shipmentNumber");
    const shipmentNumber = await runTransaction(db, async (tx) => {
        const counterSnap = await tx.get(counterRef);
        const palletRefs = uniquePalletIds.map((id) => doc(db, PALLETS_COLLECTION, id));
        const palletSnaps = await Promise.all(palletRefs.map((ref) => tx.get(ref)));
        const pallets = palletSnaps.map((snap, index) => {
            if (!snap.exists()) throw new Error(`המשטח ${uniquePalletIds[index]} כבר לא קיים`);
            const pallet = { id: snap.id, ...snap.data() } as Pallet;
            if (pallet.zone === "shipped") throw new Error(`המשטח ${pallet.id} כבר נשלח`);
            return pallet;
        });
        const totalsMap = new Map<string, { itemType: string; beerStyle: string; totalQuantity: number }>();
        pallets.forEach((pallet) => {
            const key = `${pallet.itemType}__${pallet.beerStyle}`;
            const current = totalsMap.get(key);
            if (current) current.totalQuantity += pallet.quantity;
            else totalsMap.set(key, { itemType: pallet.itemType, beerStyle: pallet.beerStyle, totalQuantity: pallet.quantity });
        });
        const currentNumber = counterSnap.exists() ? Number(counterSnap.data().value) : 2389;
        if (!Number.isFinite(currentNumber)) throw new Error("מונה תעודות המשלוח אינו תקין");
        const nextNumber = currentNumber + 1;
        const shipmentRef = doc(db, SHIPMENTS_COLLECTION, String(nextNumber));
        tx.set(counterRef, { value: nextNumber }, { merge: true });
        tx.set(shipmentRef, { shipmentNumber: nextNumber, palletIds: uniquePalletIds, totals: Array.from(totalsMap.values()), customerName: customerName?.trim() || null, customerId: customerId?.trim() || null, createdAt: serverTimestamp() });
        palletRefs.forEach((ref) => tx.update(ref, { zone: "shipped", markedForShipment: false, shippedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
        return nextNumber;
    });
    return String(shipmentNumber);
}

export function subscribeToCooler(callback: (pallets: Pallet[]) => void): () => void { return subscribeToZone("cooler", callback); }

export type ZoneCounts = Record<PalletZone, number>;

export async function getZoneCounts(): Promise<ZoneCounts> {
    const zones: PalletZone[] = ["pending", "bottleRoom", "loadingDock", "cooler"];
    const values = await Promise.all(zones.map(async (zone) => { const q = query(collection(db, PALLETS_COLLECTION), where("zone", "==", zone)); const snap = await getCountFromServer(q); return [zone, snap.data().count] as const; }));
    return Object.fromEntries(values) as ZoneCounts;
}

export async function movePalletToCell(palletId: string, cell: CoolerCell, slotIndex: number): Promise<void> {
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => { const snap = await tx.get(ref); if (!snap.exists()) throw new Error('המשטח כבר לא קיים - כנראה הוזז/נערך על ידי מישהו אחר, רענן ונסה שוב'); const data = snap.data() as Pallet; if (data.zone !== "cooler" && data.zone !== "pending" && data.zone !== "bottleRoom") throw new Error("לא ניתן לשבץ משטח מהאזור הזה במקרר"); tx.update(ref, { zone: "cooler", cell, slotIndex, orderInCell: slotIndex, updatedAt: serverTimestamp() }); });
}

export async function moveToZone(palletId: string, zone: PalletZone): Promise<void> {
    if (zone === "cooler") throw new Error("כדי להכניס למקרר יש לבחור תא במפה");
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => { const snap = await tx.get(ref); if (!snap.exists()) throw new Error('המשטח כבר לא קיים - כנראה הוזז/נערך על ידי מישהו אחר, רענן ונסה שוב'); tx.update(ref, { zone, cell: null, slotIndex: null, orderInCell: null, updatedAt: serverTimestamp() }); });
}

export async function movePalletsToZone(palletIds: string[], zone: PalletZone): Promise<void> {
    if (zone === "cooler") throw new Error("העברה למקרר נעשית באמצעות בחירת תא במפה");
    if (palletIds.length === 0) return;
    const batch = writeBatch(db);
    palletIds.forEach((id) => batch.update(doc(db, PALLETS_COLLECTION, id), { zone, cell: null, slotIndex: null, orderInCell: null, updatedAt: serverTimestamp() }));
    await batch.commit();
}

export async function setMarkedForShipment(palletId: string, marked: boolean): Promise<void> { await updateDoc(doc(db, PALLETS_COLLECTION, palletId), { markedForShipment: marked, updatedAt: serverTimestamp() }); }

export async function reorderPalletsInZone(orderedPalletIds: string[]): Promise<void> {
    const batch = writeBatch(db);
    orderedPalletIds.forEach((id, index) => batch.update(doc(db, PALLETS_COLLECTION, id), { orderInZone: index, updatedAt: serverTimestamp() }));
    await batch.commit();
}
