import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../../firebase";

const HISTORY_LIMIT = 10;

export type CoolerHistoryCounts = {
    undo: number;
    redo: number;
};

/**
 * Undo and redo badges used to attach two identical Firestore listeners to the
 * same latest-10 history query. Read it once and derive both counters locally.
 */
export function subscribeToCoolerHistoryCounts(
    callback: (counts: CoolerHistoryCounts) => void
): () => void {
    const historyQuery = query(
        collection(db, "coolerUndoHistory"),
        orderBy("createdAtMs", "desc"),
        limit(HISTORY_LIMIT),
    );

    return onSnapshot(historyQuery, (snapshot) => {
        let undo = 0;
        let redo = 0;

        snapshot.docs.forEach((item) => {
            const data = item.data();
            if (!data.undoneAt) undo += 1;
            if (data.undoneAt && !data.redoneAt) redo += 1;
        });

        callback({ undo, redo });
    }, (error) => {
        console.error("Cooler history count subscription failed", error);
        callback({ undo: 0, redo: 0 });
    });
}
