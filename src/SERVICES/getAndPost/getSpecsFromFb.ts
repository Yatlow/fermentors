import {
    collection,
    getDocs,
    query,
} from "firebase/firestore";

import { db } from "../../firebase";

export type SpecChart = Record<string, Record<string, number>>;

// ============================================================
// GET CELLAR SPECS
// ============================================================
export async function getSpecsFromFb() {
    const measurementsRef = collection(db, "specs");
    const measurementsQuery = query(measurementsRef);
    const snapshot = await getDocs(measurementsQuery);
    const specs: SpecChart = {};

    snapshot.docs.forEach((doc) => {
        // Brewing configuration and the legacy hops AA document are not cellar
        // specs. Hop AA now has a single source of truth in the brewing
        // ingredient library.
        if (doc.id.startsWith("brewing") || doc.id === "hops") return;
        specs[doc.id] = doc.data() as Record<string, number>;
    });

    return specs;
}