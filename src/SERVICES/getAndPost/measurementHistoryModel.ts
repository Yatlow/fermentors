export type MeasurementHistoryLike = {
  id?: string | number | null;
};

export function measurementDayKeyFromId(id: unknown): string | null {
  const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_\d{4})?$/);
  return match ? match[1] : null;
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
  const sorted = [...rows].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
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
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
}
