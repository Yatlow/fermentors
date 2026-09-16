import {
    collection,
    doc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    runTransaction,
    serverTimestamp,
    type DocumentData,
    type Timestamp,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import type { CoolerCell, PalletZone } from "./Pallettypes ";

const HISTORY_COLLECTION = "coolerUndoHistory";
const HISTORY_LIMIT = 10;

type PalletLocationSnapshot = {
    id: string;
    zone: PalletZone;
    cell: CoolerCell | null;
    slotIndex: number | null;
    orderInCell: number | null;
    orderInZone: number | null;
};

type UndoHistoryDocument = {
    label: string;
    before: PalletLocationSnapshot[];
    after: PalletLocationSnapshot[];
    createdAtMs: number;
    undoneAt?: Timestamp | null;
    redoneAt?: Timestamp | null;
};

function nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCell(value: unknown): CoolerCell | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as { side?: unknown; col?: unknown; row?: unknown };
    if (raw.side !== "right" && raw.side !== "left" && raw.side !== "corridor") return null;
    const col = Number(raw.col);
    const row = Number(raw.row);
    if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
    return { side: raw.side, col, row };
}

function locationFromData(id: string, data: DocumentData): PalletLocationSnapshot {
    return {
        id,
        zone: data.zone as PalletZone,
        cell: normalizeCell(data.cell),
        slotIndex: nullableNumber(data.slotIndex),
        orderInCell: nullableNumber(data.orderInCell),
        orderInZone: nullableNumber(data.orderInZone),
    };
}

function sameCell(a: CoolerCell | null, b: CoolerCell | null): boolean {
    if (a === null || b === null) return a === b;
    return a.side === b.side && a.col === b.col && a.row === b.row;
}

function sameLocation(a: PalletLocationSnapshot, b: PalletLocationSnapshot): boolean {
    return a.id === b.id &&
        a.zone === b.zone &&
        sameCell(a.cell, b.cell) &&
        a.slotIndex === b.slotIndex &&
        a.orderInCell === b.orderInCell &&
        a.orderInZone === b.orderInZone;
}

function undoneMillis(value: unknown): number {
    if (!value || typeof value !== "object") return 0;
    const timestamp = value as Timestamp;
    return typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;
}

function isRedoCandidate(data: DocumentData): boolean {
    return Boolean(data.undoneAt) && !data.redoneAt;
}

export function subscribeToCoolerRedoCount(callback: (count: number) => void): () => void {
    const historyQuery = query(
        collection(db, HISTORY_COLLECTION),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT),
    );

    return onSnapshot(historyQuery, (snapshot) => {
        callback(snapshot.docs.filter((item) => isRedoCandidate(item.data())).length);
    }, (error) => {
        console.error("Cooler redo count subscription failed", error);
        callback(0);
    });
}

export async function redoLastCoolerMove(): Promise<{ label: string; restoredCount: number }> {
    const recent = await getDocs(query(
        collection(db, HISTORY_COLLECTION),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT),
    ));

    const candidate = recent.docs
        .filter((item) => isRedoCandidate(item.data()))
        .sort((a, b) => undoneMillis(b.data().undoneAt) - undoneMillis(a.data().undoneAt))[0];

    if (!candidate) throw new Error("אין פעולה לביצוע מחדש");

    const data = candidate.data() as UndoHistoryDocument;
    const before = data.before ?? [];
    const after = data.after ?? [];
    if (!before.length || before.length !== after.length) {
        throw new Error("היסטוריית הפעולה אינה תקינה");
    }

    await runTransaction(db, async (tx) => {
        const historySnapshot = await tx.get(candidate.ref);
        if (!historySnapshot.exists()) throw new Error("הפעולה כבר לא קיימת בהיסטוריה");
        const historyData = historySnapshot.data();
        if (!historyData.undoneAt || historyData.redoneAt) {
            throw new Error("הפעולה כבר בוצעה מחדש ממכשיר אחר");
        }

        const palletRefs = before.map((item) => doc(db, "pallets", item.id));
        const palletSnapshots = await Promise.all(palletRefs.map((ref) => tx.get(ref)));

        palletSnapshots.forEach((snapshot, index) => {
            if (!snapshot.exists()) throw new Error("אחד המשטחים כבר לא קיים ולכן אי אפשר לבצע מחדש בבטחה");
            const current = locationFromData(snapshot.id, snapshot.data());
            if (!sameLocation(current, before[index])) {
                throw new Error("אחד המשטחים הוזז מאז הביטול. ביצוע מחדש נעצר כדי לא לדרוס שינוי חדש.");
            }
        });

        palletRefs.forEach((ref, index) => {
            const target = after[index];
            tx.update(ref, {
                zone: target.zone,
                cell: target.cell,
                slotIndex: target.slotIndex,
                orderInCell: target.orderInCell,
                orderInZone: target.orderInZone,
                updatedAt: serverTimestamp(),
            });
        });

        // Keep undoneAt as the audit record of the original undo. redoneAt makes
        // this history item ineligible for another redo. The movement recorder
        // will record the forward replay as the new active action, so Ctrl+Z can
        // immediately undo the redo again.
        tx.update(candidate.ref, {
            redoneAt: serverTimestamp(),
            redoneByUid: auth.currentUser?.uid ?? null,
        });
    });

    return {
        label: data.label || "שינוי מיקום במקרר",
        restoredCount: after.length,
    };
}
