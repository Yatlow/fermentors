import {
    collection,
    doc,
    addDoc,
    updateDoc,
    getDoc,
    setDoc,
    onSnapshot,
    query,
    where,
    runTransaction,
    writeBatch,
    serverTimestamp,
    getCountFromServer,
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

async function createPalletDocument(input: {
    itemType: PalletItemType;
    beerStyle: string;
    subLabel?: string | null;
    quantity: number;
    expiryDateStr?: string | null;
    batchNumber?: string | null;
    sourceTankNumber?: string | number | null;
}): Promise<string> {
    const ref = await addDoc(collection(db, PALLETS_COLLECTION), {
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
    });
    return ref.id;
}

export async function createPalletsFromPackaging(params: CreatePalletsParams): Promise<string[]> {
    const { itemType, totalQuantity, beerStyle, batchNumber, expiryDateStr, sourceTankNumber } = params;
    if (!totalQuantity || totalQuantity <= 0) return [];

    const maxPerPallet = maxPerPalletFor(itemType);
    const ids: string[] = [];
    for (const quantity of splitQuantity(totalQuantity, maxPerPallet)) {
        ids.push(await createPalletDocument({ itemType, beerStyle, quantity, batchNumber: batchNumber == null ? null : String(batchNumber), expiryDateStr, sourceTankNumber }));
    }
    return ids;
}

// ============================================================================
// ⚠️ חדש - חלוקת משטחים הניתנת לעריכה ע"י המשתמש (מסך אישור אריזה)
// ============================================================================

/** שורת משטח בודדת בחלוקה - כמות + תווית משנה אופציונלית */
export type CustomPalletSplitEntry = {
    quantity: number;
    subLabel?: string | null;
};

/**
 * מחשבת את חלוקת ברירת המחדל (האוטומטית) למשטחים, כדי להציג למשתמש נקודת התחלה לעריכה.
 * חישוב מקומי בלבד - לא נוגע ב-Firestore.
 */
export function getDefaultPalletSplit(
    itemType: PalletItemType,
    totalQuantity: number
): CustomPalletSplitEntry[] {
    if (!totalQuantity || totalQuantity <= 0) return [];
    const maxPerPallet = maxPerPalletFor(itemType);
    return splitQuantity(totalQuantity, maxPerPallet).map((quantity) => ({
        quantity,
        subLabel: null,
    }));
}

/** הגבלת הכמות המקסימלית למשטח בודד, לפי סוג הפריט (לשימוש בוולידציה בטופס העריכה) */
export function getMaxQuantityPerPallet(itemType: PalletItemType): number {
    return maxPerPalletFor(itemType);
}

export type CreatePalletsFromCustomSplitParams = {
    itemType: PalletItemType;
    /** הכמות הכוללת שדווחה בפועל (למשל מתוך packagingMasterSheetLogger) - חובה שסכום splits יהיה שווה לה בדיוק */
    expectedTotalQuantity: number;
    beerStyle: string;
    batchNumber: string | number | null | undefined;
    expiryDateStr: string;
    sourceTankNumber: string | number | null | undefined;
    splits: CustomPalletSplitEntry[];
};

/**
 * יוצרת משטחים לפי חלוקה שהמשתמש קבע/ערך ידנית (לא בהכרח שווה בשווה עד המקסימום).
 *
 * ולידציה קריטית: סכום הכמויות ב-splits חייב להיות שווה בדיוק לכמות שדווחה בפועל
 * (expectedTotalQuantity) - כדי שלא ניתן יהיה בטעות ליצור יותר (או פחות) משטחים
 * ממה שבאמת נארז. כל שורה בנפרד גם לא יכולה לחרוג מהמקסימום המותר למשטח מהסוג הזה.
 */
export async function createPalletsFromCustomSplit(
    params: CreatePalletsFromCustomSplitParams
): Promise<string[]> {
    const {
        itemType,
        expectedTotalQuantity,
        beerStyle,
        batchNumber,
        expiryDateStr,
        sourceTankNumber,
        splits,
    } = params;

    const expectedTotal = Math.round(expectedTotalQuantity);
    if (!expectedTotal || expectedTotal <= 0) return [];

    const sanitized = splits
        .map((s) => ({ quantity: Math.round(s.quantity), subLabel: s.subLabel?.trim() || null }))
        .filter((s) => s.quantity > 0);

    if (sanitized.length === 0) {
        throw new Error("יש להזין לפחות משטח אחד עם כמות גדולה מ-0");
    }

    const actualTotal = sanitized.reduce((sum, s) => sum + s.quantity, 0);
    if (actualTotal !== expectedTotal) {
        const unit = itemType === "kegs" ? "חביות" : "ארגזים";
        throw new Error(
            `סך כל המשטחים (${actualTotal} ${unit}) לא תואם לכמות שדווחה בפועל (${expectedTotal} ${unit}). יש לתקן את החלוקה כך שהסכום יהיה זהה.`
        );
    }

    const maxPerPallet = maxPerPalletFor(itemType);
    const overLimit = sanitized.find((s) => s.quantity > maxPerPallet);
    if (overLimit) {
        const unit = itemType === "kegs" ? "חביות" : "ארגזים";
        throw new Error(
            `משטח בודד יכול להכיל עד ${maxPerPallet} ${unit} (נמצא משטח עם ${overLimit.quantity})`
        );
    }

    const ids: string[] = [];
    for (const entry of sanitized) {
        ids.push(
            await createPalletDocument({
                itemType,
                beerStyle,
                subLabel: entry.subLabel,
                quantity: entry.quantity,
                batchNumber: batchNumber == null ? null : String(batchNumber),
                expiryDateStr,
                sourceTankNumber,
            })
        );
    }
    return ids;
}

// ============================================================================

export function subscribeToZone(zone: PalletZone, cb: (pallets: Pallet[]) => void) {
    const q = query(collection(db, PALLETS_COLLECTION), where("zone", "==", zone));
    return onSnapshot(
        q,
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Pallet))),
        (err) => console.error(`subscribeToZone(${zone}) error:`, err)
    );
}

export async function updatePallet(palletId: string, input: {
    itemType: PalletItemType;
    beerStyle: string;
    subLabel?: string | null;
    quantity: number;
    expiryDateStr?: string | null;
    batchNumber?: string | null;
}) {
    if (!input.beerStyle.trim()) throw new Error("יש להזין סגנון בירה");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("כמות חייבת להיות גדולה מ-0");
    const max = maxPerPalletFor(input.itemType);
    if (input.quantity > max) throw new Error(`משטח בודד יכול להכיל עד ${max} ${input.itemType === "kegs" ? "חביות" : "ארגזים"}`);

    await updateDoc(doc(db, PALLETS_COLLECTION, palletId), {
        itemType: input.itemType,
        beerStyle: input.beerStyle.trim(),
        subLabel: input.subLabel?.trim() || null,
        quantity: Math.round(input.quantity),
        heightCm: calcHeightCm(input.itemType, Math.round(input.quantity)),
        expiryDateStr: input.expiryDateStr?.trim() || null,
        batchNumber: input.batchNumber?.trim() || null,
        updatedAt: serverTimestamp(),
    });
}

export async function updatePalletQuantity(palletId: string, quantity: number) {
    const snap = await getDoc(doc(db, PALLETS_COLLECTION, palletId));
    if (!snap.exists()) throw new Error("המשטח לא נמצא");
    const pallet = snap.data() as Pallet;
    await updatePallet(palletId, {
        itemType: pallet.itemType,
        beerStyle: pallet.beerStyle,
        subLabel: pallet.subLabel,
        quantity,
        expiryDateStr: pallet.expiryDateStr,
        batchNumber: pallet.batchNumber,
    });
}

export async function deletePallet(palletId: string): Promise<void> {
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("המשטח כבר לא קיים");
        tx.delete(ref);
    });
}

export async function splitPallet(palletId: string, splitQty: number, splitLabel: string | null) {
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("המשטח לא נמצא");
    const pallet = { id: snap.id, ...(snap.data() as any) } as Pallet;
    if (splitQty <= 0 || splitQty >= pallet.quantity) throw new Error("כמות הפיצול חייבת להיות בין 1 לכמות פחות 1");

    const remainingQty = pallet.quantity - splitQty;
    const batch = writeBatch(db);
    batch.update(ref, {
        quantity: remainingQty,
        heightCm: calcHeightCm(pallet.itemType, remainingQty),
        updatedAt: serverTimestamp(),
    });
    const newRef = doc(collection(db, PALLETS_COLLECTION));
    batch.set(newRef, {
        itemType: pallet.itemType,
        beerStyle: pallet.beerStyle,
        subLabel: splitLabel ?? pallet.subLabel ?? null,
        quantity: splitQty,
        heightCm: calcHeightCm(pallet.itemType, splitQty),
        expiryDateStr: pallet.expiryDateStr ?? null,
        markedForShipment: false,
        zone: "pending",
        cell: null,
        slotIndex: null,
        orderInCell: null,
        batchNumber: pallet.batchNumber ?? null,
        sourceTankNumber: pallet.sourceTankNumber ?? null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    await batch.commit();
}

export async function reorderPalletsInCell(orderedPalletIds: string[]) {
    const batch = writeBatch(db);
    orderedPalletIds.forEach((id, index) => {
        batch.update(doc(db, PALLETS_COLLECTION, id), { orderInCell: index, slotIndex: index, updatedAt: serverTimestamp() });
    });
    await batch.commit();
}


export async function createPallet(input: {
    itemType: PalletItemType;
    beerStyle: string;
    subLabel?: string | null;
    quantity: number;
    expiryDateStr?: string | null;
    batchNumber?: string | null;
}): Promise<string> {
    const ids = await createPallets({ ...input, palletCount: 1 });
    return ids[0];
}

export async function createPallets(input: {
    itemType: PalletItemType;
    beerStyle: string;
    subLabel?: string | null;
    quantity: number;
    palletCount?: number;
    expiryDateStr?: string | null;
    batchNumber?: string | null;
}): Promise<string[]> {
    if (!input.beerStyle.trim()) throw new Error("יש להזין סגנון בירה");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("כמות חייבת להיות גדולה מ-0");

    const max = maxPerPalletFor(input.itemType);
    const totalModeChunks = splitQuantity(input.quantity, max);
    const chunks = input.palletCount && input.palletCount > 1
        ? Array.from({ length: Math.floor(input.palletCount) }, () => input.quantity)
        : totalModeChunks;

    if (chunks.some((q) => q > max)) throw new Error(`משטח בודד יכול להכיל עד ${max} ${input.itemType === "kegs" ? "חביות" : "ארגזים"}`);

    const ids: string[] = [];
    for (const quantity of chunks) {
        ids.push(await createPalletDocument({ ...input, quantity }));
    }
    return ids;
}
export const MAX_TRUCK_SLOTS = 12;
export const MAX_TRUCK_HEIGHT_CM = 190;

export function calcTruckSlots(
    pallets: Pallet[]
): number {
    const heights = pallets
        .map((pallet) =>
            calcHeightCm(
                pallet.itemType,
                pallet.quantity
            )
        )
        .sort((a, b) => b - a);

    // כל מקום במשאית מתחיל כ"מקום" ריק.
    // בכל מקום אפשר לשים משטח אחד או לערום
    // משטח נוסף, כל עוד הגובה הכולל <= 190.
    const slots: number[] = [];

    for (const height of heights) {
        // אם המשטח עצמו גבוה מדי למשאית
        if (height > MAX_TRUCK_HEIGHT_CM) {
            throw new Error(
                `משטח בגובה ${height} ס"מ לא יכול להיכנס למשאית (מקסימום ${MAX_TRUCK_HEIGHT_CM} ס"מ)`
            );
        }

        // מחפשים מקום קיים שבו אפשר לערום אותו.
        // Best fit: נבחר את המקום שהכי קרוב ל-190
        // אחרי הכנסת המשטח.
        let bestSlotIndex = -1;
        let bestRemainingHeight =
            Infinity;

        for (
            let i = 0;
            i < slots.length;
            i++
        ) {
            const newHeight =
                slots[i] + height;

            if (
                newHeight <=
                MAX_TRUCK_HEIGHT_CM
            ) {
                const remaining =
                    MAX_TRUCK_HEIGHT_CM -
                    newHeight;

                if (
                    remaining <
                    bestRemainingHeight
                ) {
                    bestRemainingHeight =
                        remaining;

                    bestSlotIndex = i;
                }
            }
        }

        if (bestSlotIndex >= 0) {
            slots[bestSlotIndex] += height;
        } else {
            slots.push(height);
        }
    }

    return slots.length;
}

async function getNextShipmentNumber(): Promise<number> {
    const counterRef = doc(db, "counters", "shipmentNumber");
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(counterRef);
        const current = snap.exists() ? (snap.data().value as number) : 2389; // כך שהראשון יהיה 2390
        const next = current + 1;
        tx.set(counterRef, { value: next }, { merge: true });
        return next;
    });
}

export async function createShipment(
    palletIds: string[],
    customerName?: string | null
): Promise<string> {
    if (palletIds.length === 0) throw new Error("לא נבחרו משטחים למשלוח");

    const snaps = await Promise.all(
        palletIds.map((id) => getDoc(doc(db, PALLETS_COLLECTION, id)))
    );

    const pallets = snaps
        .filter((snap) => snap.exists())
        .map((snap) => ({ id: snap.id, ...snap.data() } as Pallet));

    const totalsMap = new Map<string, { itemType: string; beerStyle: string; totalQuantity: number }>();
    pallets.forEach((p) => {
        const key = `${p.itemType}__${p.beerStyle}`;
        const cur = totalsMap.get(key);
        if (cur) cur.totalQuantity += p.quantity;
        else totalsMap.set(key, { itemType: p.itemType, beerStyle: p.beerStyle, totalQuantity: p.quantity });
    });

    const shipmentNumber = await getNextShipmentNumber();

    await setDoc(doc(db, SHIPMENTS_COLLECTION, String(shipmentNumber)), {
        shipmentNumber,
        palletIds,
        totals: Array.from(totalsMap.values()),
        customerName: customerName?.trim() || null, // חדש
        createdAt: serverTimestamp(),
    });

    const batch = writeBatch(db);
    palletIds.forEach((id) => batch.update(doc(db, PALLETS_COLLECTION, id), {
        zone: "shipped",
        markedForShipment: false,
        shippedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    }));
    await batch.commit();

    return String(shipmentNumber);
}

export function subscribeToCooler(callback: (pallets: Pallet[]) => void): () => void {
    return subscribeToZone("cooler", callback);
}

export type ZoneCounts = Record<PalletZone, number>;

export async function getZoneCounts(): Promise<ZoneCounts> {
    // נשמר לתאימות עם קוד קיים. ה-UI החדש משתמש ב-subscribeToZone ולכן
    // המספרים עצמם מתעדכנים ב-realtime.
    const zones: PalletZone[] = ["pending", "bottleRoom", "loadingDock", "cooler"];
    const values = await Promise.all(zones.map(async (zone) => {
        const q = query(collection(db, PALLETS_COLLECTION), where("zone", "==", zone));
        const snap = await getCountFromServer(q);
        return [zone, snap.data().count] as const;
    }));
    return Object.fromEntries(values) as ZoneCounts;
}

export async function movePalletToCell(palletId: string, cell: CoolerCell, slotIndex: number): Promise<void> {
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('המשטח כבר לא קיים - כנראה הוזז/נערך על ידי מישהו אחר, רענן ונסה שוב');
        const data = snap.data() as Pallet;
        if (data.zone !== "cooler" && data.zone !== "pending" && data.zone !== "bottleRoom") {
            throw new Error("לא ניתן לשבץ משטח מהאזור הזה במקרר");
        }
        tx.update(ref, { zone: "cooler", cell, slotIndex, orderInCell: slotIndex, updatedAt: serverTimestamp() });
    });
}

export async function moveToZone(palletId: string, zone: PalletZone): Promise<void> {
    if (zone === "cooler") throw new Error("כדי להכניס למקרר יש לבחור תא במפה");
    const ref = doc(db, PALLETS_COLLECTION, palletId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('המשטח כבר לא קיים - כנראה הוזז/נערך על ידי מישהו אחר, רענן ונסה שוב');
        tx.update(ref, { zone, cell: null, slotIndex: null, orderInCell: null, updatedAt: serverTimestamp() });
    });
}

export async function movePalletsToZone(palletIds: string[], zone: PalletZone): Promise<void> {
    if (zone === "cooler") throw new Error("העברה למקרר נעשית באמצעות בחירת תא במפה");
    if (palletIds.length === 0) return;
    const batch = writeBatch(db);
    palletIds.forEach((id) => batch.update(doc(db, PALLETS_COLLECTION, id), {
        zone, cell: null, slotIndex: null, orderInCell: null, updatedAt: serverTimestamp(),
    }));
    await batch.commit();
}

export async function setMarkedForShipment(palletId: string, marked: boolean): Promise<void> {
    await updateDoc(doc(db, PALLETS_COLLECTION, palletId), { markedForShipment: marked, updatedAt: serverTimestamp() });
}
export async function reorderPalletsInZone(
    orderedPalletIds: string[]
): Promise<void> {
    const batch = writeBatch(db);

    orderedPalletIds.forEach((id, index) => {
        batch.update(
            doc(db, PALLETS_COLLECTION, id),
            {
                orderInZone: index,
                updatedAt: serverTimestamp(),
            }
        );
    });

    await batch.commit();
}