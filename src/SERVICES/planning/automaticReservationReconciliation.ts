import type { Pallet } from "../cooler/Pallettypes ";

type ReservationState = Pick<Pallet, "id" | "markedForShipment" |
  "autoReservationWeek" | "autoReservationTruckId">;

/** Idempotent reconciliation for the nearest truck. Never clears a manual mark.
 * The original mark metadata is included in each mutation to prevent a stale
 * read from releasing a pallet re-assigned by another device meanwhile.
 */
export function automaticReservationDelta(
  pallets: ReservationState[],
  desiredIds: ReadonlySet<string>,
  week: string,
  truckId: string | null,
) {
  const releaseIds: string[] = [];
  const assignIds: string[] = [];
  const originalAuto = new Map<string, {
    week: string; truckId: string | null;
  }>();
  for (const pallet of pallets) {
    if (pallet.markedForShipment && pallet.autoReservationWeek) {
      originalAuto.set(pallet.id, {
        week: pallet.autoReservationWeek,
        truckId: pallet.autoReservationTruckId ?? null,
      });
      if (!desiredIds.has(pallet.id)) releaseIds.push(pallet.id);
    }
  }
  for (const id of desiredIds) {
    const pallet = pallets.find((candidate) => candidate.id === id);
    if (!pallet) continue;
    if (pallet.markedForShipment && !pallet.autoReservationWeek) continue;
    if (!pallet.markedForShipment || pallet.autoReservationWeek !== week ||
        (pallet.autoReservationTruckId ?? null) !== truckId) assignIds.push(id);
  }
  return { releaseIds, assignIds, originalAuto };
}
