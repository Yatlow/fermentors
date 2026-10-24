import { parseDate } from "../planning/planningEngine";
import type { Pallet } from "./Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "./truckCapacity";

/** Single authoritative physical dispatch gate. Call INSIDE the Firestore
 * transaction after reading current pallet documents, never only in React.
 * No customer or plan exception can override physical truck safety.
 */
export function validatePhysicalShipmentLoad(pallets: Pallet[], date: string): number {
  if (!pallets.length) throw new Error("לא נבחרו משטחים למשלוח");
  for (const pallet of pallets) {
    if (pallet.zone !== "loadingDock")
      throw new Error(`משטח ${pallet.id} אינו במשטח הטעינה. יש לרענן לפני שילוח.`);
    const quantity = Number(pallet.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity))
      throw new Error(`משטח ${pallet.id}: כמות המשטח אינה תקינה.`);
    const expiry = parseDate(pallet.expiryDateStr);
    if (!expiry || expiry < date)
      throw new Error(`משטח ${pallet.id}: תאריך התפוגה חסר או חלף. שילוח מחייב תיקון ובקרת איכות.`);
  }
  const slots = calcTruckSlots(pallets);
  if (slots > MAX_TRUCK_SLOTS)
    throw new Error(`המשאית חורגת מקיבולת ${MAX_TRUCK_SLOTS} מקומות (נבחרו ${slots}).`);
  return slots;
}
