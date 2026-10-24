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

/**
 * Notes, dismissals and historical recommendation evidence do not change
 * physical capacity, pallet allocations or stock timing. Avoid reading the
 * entire multi-week planning fence for these metadata-only saves.
 *
 * Every field that CAN affect a current or downstream production decision
 * remains fenced. New week creations always need the full horizon.
 */
export function planningRequiresCrossWeekFence(
  previous: WeekPlan | undefined,
  edited: WeekPlan,
): boolean {
  if (!previous) return true;
  const operationalFields = [
    "packaging", "brews", "deliveries", "deliveryDates", "maxRuns",
    "allowExceptions", "oversizeTruckApprovals", "calendarEvents", "calendarNotes",
  ] as const;
  // Calendar metadata is persisted by the UI's extended WeekPlan shape.
  // Keep the pure helper compatible with the core WeekPlan type while still
  // treating those optional scheduling fields as operational changes.
  type ExtendedWeek = WeekPlan & {
    calendarEvents?: unknown;
    calendarNotes?: unknown;
  };
  const before = previous as ExtendedWeek;
  const after = edited as ExtendedWeek;
  return operationalFields.some((key) =>
    JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
