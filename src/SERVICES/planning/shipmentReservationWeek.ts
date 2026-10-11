import { addDays, weekStart } from "./planningEngine";

/** Saturday at 20:00 Asia/Jerusalem opens the coming Sunday's shipment week. */
export function autoReservationWeek(today: string, hourInIsrael: number): string {
  const current = weekStart(today);
  return new Date(today + "T12:00:00Z").getUTCDay() === 6 && hourInIsrael >= 20
    ? addDays(current, 7) : current;
}

export function isDispatchInReservationWeek(dispatchDate: string, today: string, hourInIsrael: number): boolean {
  return dispatchDate >= today && weekStart(dispatchDate) === autoReservationWeek(today, hourInIsrael);
}
