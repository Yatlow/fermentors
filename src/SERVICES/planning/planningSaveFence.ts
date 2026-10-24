import { addDays, weekStart, type WeekPlan } from "./planningEngine";

/**
 * A weekly change may affect a DIFFERENT week's inventory, tank release or
 * shipment. Reading only the edited document inside a Firestore transaction
 * cannot serialize two simultaneous edits of different weeks.
 *
 * Read the exact rolling horizon represented by usePlanning (12 prior weeks,
 * the current week, and 12 future weeks), including ABSENT documents, inside
 * the SAME transaction that persists the edited week. Firestore retries if
 * another writer creates or changes any document read by this transaction.
 * Upon retry we compare with the UI's previously validated versions and fail
 * closed, prompting a refresh and revalidation rather than silently merging.
 */
export function planningSaveFenceWeekIds(currentDate: string): string[] {
  const start = weekStart(currentDate);
  return Array.from({ length: 25 }, (_, index) => addDays(start, (index - 12) * 7));
}

export type PlanningFenceVersion = { id: string; revision: number | null };

export function planningSaveFenceConflict(
  expected: WeekPlan[],
  actual: PlanningFenceVersion[],
  editedWeekId: string,
): string | null {
  const byId = new Map(expected.map((week) => [week.id, week.revision ?? null]));
  for (const observed of actual) {
    if (observed.id === editedWeekId) continue; // checked by save() separately
    const before = byId.get(observed.id) ?? null;
    const now = observed.revision ?? null;
    if (before !== now) return observed.id;
  }
  return null;
}
