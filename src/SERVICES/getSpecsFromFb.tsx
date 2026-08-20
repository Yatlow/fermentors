import {
    collection,
    getDocs,
    query,
} from "firebase/firestore";

import { db } from "../firebase";

export type SpecChart = Record<string, Record<string, number>>;

// ============================================================
// GET ALL MEASUREMENTS FOR BATCH
// ============================================================

// export async function getSpecsFromFb()<<SpecChart>() => []> {
export async function getSpecsFromFb() {



    // ----------------------------------------------------------
    // NORMALIZE BATCH ID
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // FIRESTORE PATH
    // ----------------------------------------------------------

    const measurementsRef = collection(
        db,
        "specs",
    );

    // ----------------------------------------------------------
    // QUERY
    // ----------------------------------------------------------

    const measurementsQuery = query(
        measurementsRef);

    // ----------------------------------------------------------
    // GET DATA
    // ----------------------------------------------------------

    const snapshot = await getDocs(
        measurementsQuery
    );

    // ----------------------------------------------------------
    // CONVERT FIRESTORE DATA
    // ----------------------------------------------------------

    const specs: SpecChart = {};

    snapshot.docs.forEach((doc) => {
        specs[doc.id] = doc.data() as Record<string, number>;
    });

    return specs;
}