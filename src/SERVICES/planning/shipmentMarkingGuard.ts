import { doc, getDocFromServer, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../../firebase";

/** Shared revision token for manual and automatic pallet selection.
 * Read BEFORE discovering marked pallets / calculating FEFO. Every shipment
 * marking transaction must read and increment this document atomically, so
 * a concurrent decision cannot commit based on an older inventory snapshot.
 */
export const shipmentMarkingGuardRef = () =>
  doc(db, "shipmentMarkingGuard", "active");

export async function readShipmentMarkingRevision(): Promise<number> {
  const snap = await getDocFromServer(shipmentMarkingGuardRef());
  return Number(snap.data()?.revision ?? 0);
}

export function nextShipmentMarkingRevision(
  current: number,
  expected: number,
): number {
  if (!Number.isInteger(current) || current !== expected) {
    throw new Error("סימון המשטחים השתנה במכשיר אחר. יש לרענן ולנסות מחדש.");
  }
  return current + 1;
}

export function shipmentMarkingGuardWrite(revision: number) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("נדרשת התחברות");
  return { revision, updatedAt: serverTimestamp(), updatedBy: uid };
}
