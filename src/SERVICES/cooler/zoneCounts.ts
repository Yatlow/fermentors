import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import type { PalletZone } from "./Pallettypes ";
import type { ZoneCounts } from "./Palletservice";

const ACTIVE_ZONES: PalletZone[] = ["cooler", "pending", "bottleRoom", "loadingDock"];

export function subscribeToZoneCounts(callback: (counts: ZoneCounts) => void): () => void {
    const q = query(
        collection(db, "pallets"),
        where("zone", "in", ACTIVE_ZONES)
    );

    return onSnapshot(
        q,
        (snapshot) => {
            const counts: ZoneCounts = {
                cooler: 0,
                pending: 0,
                bottleRoom: 0,
                loadingDock: 0,
                shipped: 0,
            };

            snapshot.docs.forEach((document) => {
                const zone = document.data().zone as PalletZone | undefined;
                if (zone && zone in counts) counts[zone] += 1;
            });

            callback(counts);
        },
        (error) => console.error("subscribeToZoneCounts error:", error)
    );
}
