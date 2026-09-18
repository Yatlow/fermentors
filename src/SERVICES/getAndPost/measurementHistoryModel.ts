export type MeasurementHistoryLike = {
  id?: string | number | null;
  notes?: string | number | null;
  [key: string]: unknown;
};

export function measurementDayKeyFromId(id: unknown): string | null {
  const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_\d{3,4})?$/);
  return match ? match[1] : null;
}

function measurementSortKey(id: unknown): string {
  const text = String(id ?? "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})_(\d{3,4})$/);
  return match ? `${match[1]}_${match[2].padStart(4, "0")}` : text;
}

function hasPatchValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function mergeNotes(existing: unknown, incoming: unknown): unknown {
  if (!hasPatchValue(incoming)) return existing;

  const oldText = String(existing ?? "").trim();
  const newText = String(incoming ?? "").trim();
  if (!newText) return existing;
  if (!oldText) return newText;
  if (oldText === newText || oldText.split(" | ").includes(newText)) return oldText;
  return `${oldText} | ${newText}`;
}

/**
 * Merge an app-originated reading into the currently visible history without
 * inventing a second row for the same day. If that day already exists we keep
 * its canonical id/time and only overlay the fields the app just reported.
 *
 * This mirrors the Sheet behavior: one row per day, numeric fields are merged,
 * and action notes are appended to today's notes.
 */
export function mergeOptimisticMeasurementIntoHistory<T extends MeasurementHistoryLike>(
  rows: T[],
  patch: T
): T[] {
  const day = measurementDayKeyFromId(patch.id);
  if (!day) return collapseMeasurementsToLatestPerDay([...rows, patch]);

  const collapsed = collapseMeasurementsToLatestPerDay(rows);
  const index = collapsed.findIndex((row) => measurementDayKeyFromId(row.id) === day);

  if (index === -1) {
    return collapseMeasurementsToLatestPerDay([...collapsed, patch]);
  }

  const current = collapsed[index];
  const merged = { ...current } as T;

  Object.entries(patch).forEach(([key, value]) => {
    if (key === "id") return;
    if (key === "notes") {
      (merged as MeasurementHistoryLike).notes = mergeNotes(current.notes, value) as string | number | null | undefined;
      return;
    }
    if (hasPatchValue(value)) {
      (merged as Record<string, unknown>)[key] = value;
    }
  });

  collapsed[index] = merged;
  return collapsed.sort((a, b) => measurementSortKey(a.id).localeCompare(measurementSortKey(b.id)));
}

/**
 * Sheets has one fermentation row per calendar day. Firestore can temporarily
 * contain more than one document for the same day when a Sheet row is deleted
 * and recreated with a new time (the document id contains that time).
 *
 * Consumers should therefore see the last document for each day. Unknown/old
 * id formats are preserved rather than silently discarded.
 */
export function collapseMeasurementsToLatestPerDay<T extends MeasurementHistoryLike>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => measurementSortKey(a.id).localeCompare(measurementSortKey(b.id)));
  const latestByDay = new Map<string, T>();
  const passthrough: T[] = [];

  sorted.forEach((row) => {
    const day = measurementDayKeyFromId(row.id);
    if (!day) {
      passthrough.push(row);
      return;
    }
    // Sorted oldest -> newest, so a later time for the same day replaces the
    // earlier Firestore document and matches the current row in Sheets.
    latestByDay.set(day, row);
  });

  return [...latestByDay.values(), ...passthrough]
    .sort((a, b) => measurementSortKey(a.id).localeCompare(measurementSortKey(b.id)));
}
