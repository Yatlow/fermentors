import { addDays } from "./planningEngine";

/** Current + 12 future weeks, plus the previous week displayed on the Gantt. */
export const GANTT_FUTURE_WEEKS = 13;

export function planningWeekIds(currentWeek: string): string[] {
  return Array.from({ length: GANTT_FUTURE_WEEKS + 1 },
    (_, index) => addDays(currentWeek, (index - 1) * 7));
}

/** Query boundaries are exclusive; retain the entire last displayed week. */
export function planningQueryEnd(currentWeek: string): string {
  return addDays(currentWeek, GANTT_FUTURE_WEEKS * 7);
}

/** A visible page is not an independent forecast. Replay every preceding week. */
export function simulationWeeksForPage(allWeekIds: string[], visibleWeekIds: string[]): string[] {
  const last = visibleWeekIds.at(-1);
  return last ? allWeekIds.filter((week) => week <= last) : [];
}
