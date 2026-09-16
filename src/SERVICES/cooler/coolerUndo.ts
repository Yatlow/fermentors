import {
    collection,
    deleteDoc,
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

type LocationChange = {
    before: PalletLocationSnapshot;
    after: PalletLocationSnapshot;
    updatedAtMs: number;
};

type UndoHistoryDocument = {
    label: string;
    before: PalletLocationSnapshot[];
    after: PalletLocationSnapshot[];
    createdAtMs: number;
    createdByUid: string | null;
    undoneAt?: unknown;
};

let recorderStarted = false;
let initialSnapshotSeen = false;
let previousLocations = new Map<string, PalletLocationSnapshot>();

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

function timestampMillis(value: unknown): number | null {
    if (!value || typeof value !== "object") return null;
    const timestamp = value as Timestamp;
    if (typeof timestamp.toMillis === "function") {
        const ms = timestamp.toMillis();
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
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

function sortedSnapshots(items: PalletLocationSnapshot[]): PalletLocationSnapshot[] {
    return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function sameSnapshotSet(a: PalletLocationSnapshot[], b: PalletLocationSnapshot[]): boolean {
    if (a.length !== b.length) return false;
    const left = sortedSnapshots(a);
    const right = sortedSnapshots(b);
    return left.every((item, index) => sameLocation(item, right[index]));
}

function stableSnapshotText(items: PalletLocationSnapshot[]): string {
    return JSON.stringify(sortedSnapshots(items));
}

function hashText(text: string): string {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function zoneLabel(zone: PalletZone): string {
    switch (zone) {
        case "cooler": return "מקרר";
        case "pending": return "ממתינים לשיבוץ";
        case "bottleRoom": return "חדר בקבוקים";
        case "loadingDock": return "העמסה למשלוח";
        case "shipped": return "נשלח";
    }
}

function inferLabel(changes: LocationChange[]): string {
    if (changes.length > 1 && changes.every((change) => change.after.zone === "loadingDock")) {
        return `שלח מסומנים להעמסה (${changes.length} משטחים)`;
    }

    const onlyReordered = changes.every((change) =>
        change.before.zone === "cooler" &&
        change.after.zone === "cooler" &&
        sameCell(change.before.cell, change.after.cell)
    );
    if (onlyReordered) return "סידור משטחים בתוך תא";

    if (changes.length === 1) {
        const [change] = changes;
        if (change.after.zone === "cooler") {
            return change.before.zone === "cooler"
                ? "הזזת משטח במקרר"
                : "שיבוץ משטח במקרר";
        }
        return `העברת משטח ל${zoneLabel(change.after.zone)}`;
    }

    const destination = changes[0]?.after.zone;
    if (destination && changes.every((change) => change.after.zone === destination)) {
        return `העברת ${changes.length} משטחים ל${zoneLabel(destination)}`;
    }

    return `שינוי מיקום ${changes.length} משטחים`;
}

async function isUndoReplay(changes: LocationChange[]): Promise<boolean> {
    const recent = await getDocs(query(
        collection(db, HISTORY_COLLECTION),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT),
    ));

    const observedBefore = changes.map((change) => change.before);
    const observedAfter = changes.map((change) => change.after);

    return recent.docs.some((snapshot) => {
        const data = snapshot.data() as UndoHistoryDocument;
        return Boolean(data.undoneAt) &&
            sameSnapshotSet(data.after ?? [], observedBefore) &&
            sameSnapshotSet(data.before ?? [], observedAfter);
    });
}

async function trimHistory(): Promise<void> {
    const snapshot = await getDocs(query(
        collection(db, HISTORY_COLLECTION),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT + 20),
    ));

    await Promise.all(snapshot.docs.slice(HISTORY_LIMIT).map((item) => deleteDoc(item.ref)));
}

async function persistLocationChange(changes: LocationChange[]): Promise<void> {
    if (!changes.length) return;
    if (changes.some((change) => change.before.zone === "shipped" || change.after.zone === "shipped")) {
        return;
    }

    if (await isUndoReplay(changes)) return;

    const before = changes.map((change) => change.before);
    const after = changes.map((change) => change.after);
    const createdAtMs = Math.max(...changes.map((change) => change.updatedAtMs));
    const signature = `${createdAtMs}|${stableSnapshotText(before)}|${stableSnapshotText(after)}`;
    const historyRef = doc(db, HISTORY_COLLECTION, `move-${hashText(signature)}`);

    await runTransaction(db, async (tx) => {
        const existing = await tx.get(historyRef);
        if (existing.exists()) return;

        tx.set(historyRef, {
            label: inferLabel(changes),
            before,
            after,
            createdAtMs,
            createdAt: serverTimestamp(),
            createdByUid: auth.currentUser?.uid ?? null,
        });
    });

    await trimHistory();
}

export function startCoolerUndoRecorder(): void {
    if (recorderStarted) return;
    recorderStarted = true;

    onSnapshot(collection(db, "pallets"), (snapshot) => {
        if (snapshot.metadata.hasPendingWrites) return;

        const nextLocations = new Map<string, PalletLocationSnapshot>();
        snapshot.docs.forEach((item) => {
            nextLocations.set(item.id, locationFromData(item.id, item.data()));
        });

        if (!initialSnapshotSeen) {
            previousLocations = nextLocations;
            initialSnapshotSeen = true;
            return;
        }

        const changes: LocationChange[] = [];
        snapshot.docChanges().forEach((change) => {
            if (change.type !== "modified") return;
            const before = previousLocations.get(change.doc.id);
            const after = nextLocations.get(change.doc.id);
            if (!before || !after || sameLocation(before, after)) return;

            const updatedAtMs = timestampMillis(change.doc.data().updatedAt) ?? Date.now();
            changes.push({ before, after, updatedAtMs });
        });

        previousLocations = nextLocations;
        if (!changes.length) return;

        void persistLocationChange(changes).catch((error) => {
            console.error("Failed recording cooler undo history", error);
        });
    }, (error) => {
        console.error("Cooler undo recorder subscription failed", error);
    });
}

export function subscribeToCoolerUndoCount(callback: (count: number) => void): () => void {
    const historyQuery = query(
        collection(db, HISTORY_COLLECTION),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT),
    );

    return onSnapshot(historyQuery, (snapshot) => {
        callback(snapshot.docs.filter((item) => !item.data().undoneAt).length);
    }, (error) => {
        console.error("Cooler undo count subscription failed", error);
        callback(0);
    });
}

export async function undoLastCoolerMove(): Promise<{ label: string; restoredCount: number }> {
    const recent = await getDocs(query(
        collection(db, HISTORY_COLLECTION),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT),
    ));

    const candidate = recent.docs.find((item) => !item.data().undoneAt);
    if (!candidate) throw new Error("אין פעולה אחרונה לביטול");

    const data = candidate.data() as UndoHistoryDocument;
    const before = data.before ?? [];
    const after = data.after ?? [];
    if (!before.length || before.length !== after.length) {
        throw new Error("היסטוריית הביטול של הפעולה אינה תקינה");
    }

    await runTransaction(db, async (tx) => {
        const historySnapshot = await tx.get(candidate.ref);
        if (!historySnapshot.exists() || historySnapshot.data().undoneAt) {
            throw new Error("הפעולה כבר בוטלה ממכשיר אחר");
        }

        const palletRefs = after.map((item) => doc(db, "pallets", item.id));
        const palletSnapshots = await Promise.all(palletRefs.map((ref) => tx.get(ref)));

        palletSnapshots.forEach((snapshot, index) => {
            if (!snapshot.exists()) throw new Error("אחד המשטחים כבר לא קיים ולכן אי אפשר לבטל בבטחה");
            const current = locationFromData(snapshot.id, snapshot.data());
            if (!sameLocation(current, after[index])) {
                throw new Error("אחד המשטחים הוזז מאז הפעולה. הביטול נעצר כדי לא לדרוס שינוי חדש.");
            }
        });

        palletRefs.forEach((ref, index) => {
            const target = before[index];
            tx.update(ref, {
                zone: target.zone,
                cell: target.cell,
                slotIndex: target.slotIndex,
                orderInCell: target.orderInCell,
                orderInZone: target.orderInZone,
                updatedAt: serverTimestamp(),
            });
        });

        tx.update(candidate.ref, {
            undoneAt: serverTimestamp(),
            undoneByUid: auth.currentUser?.uid ?? null,
        });
    });

    return {
        label: data.label || "שינוי מיקום במקרר",
        restoredCount: before.length,
    };
}
