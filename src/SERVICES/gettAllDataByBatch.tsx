import {
  collection,
  getDocs,
  query,
  orderBy,
} from "firebase/firestore";

import { db } from "../firebase";
import type { Measurement } from "./calculateCelleringRecomendations";

// ============================================================
// GET ALL MEASUREMENTS FOR BATCH
// ============================================================

export async function getMeasurementsByBatch(
  batchNumber: string | number
): Promise<Measurement[]> {

  if (!batchNumber) {
    throw new Error("Batch number is required");
  }

  // ----------------------------------------------------------
  // NORMALIZE BATCH ID
  // ----------------------------------------------------------

  const batchId = String(batchNumber)
    .replace("#", "")
    .trim();

  // ----------------------------------------------------------
  // FIRESTORE PATH
  // ----------------------------------------------------------

  const measurementsRef = collection(
    db,
    "brews",
    batchId,
    "measurements"
  );

  // ----------------------------------------------------------
  // QUERY
  // ----------------------------------------------------------

  const measurementsQuery = query(
    measurementsRef,
    orderBy("date")
  );

  // ----------------------------------------------------------
  // GET DATA
  // ----------------------------------------------------------

  const snapshot = await getDocs(
    measurementsQuery
  );

  // ----------------------------------------------------------
  // CONVERT FIRESTORE DATA
  // ----------------------------------------------------------

  const measurements: Measurement[] =
    snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

  return measurements;
}