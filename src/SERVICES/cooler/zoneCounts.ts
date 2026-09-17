import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import type { ZoneCounts } from "./Palletservice";

export function subscribeToZoneCounts(callback: (counts: ZoneCounts) => void): () => void {
    // The global navigation badge only renders the number of pallets waiting
    // for placement. Listening to every active cooler zone kept all active
    // pallet documents attached to every signed-in client for a single badge.
    const q = query(
        collection(db, "pallets"),
        where("zone", "==", "pending")
    );

    return onSnapshot(
        q,
        (snapshot) => {
            callback({
                cooler: 0,
                pending: snapshot.size,
                bottleRoom: 0,
                loadingDock: 0,
                shipped: 0,
            });
        },
        (error) => console.error("subscribeToZoneCounts error:", error)
    );
}
