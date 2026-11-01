/** A dry-hop event has one explicit marker in the measurement notes.
 * Measurements may be merged into one daily row, so count markers rather than
 * documents. Historic hop-entry notes without that marker count once.
 */
export function dryHopActionCount(rows: ReadonlyArray<{ notes?: unknown }>): number {
  let count = 0;
  for (const row of rows) {
    const text = String(row.notes ?? "");
    const events = text.match(/דרייהופ|dry[ -]?hop/gi) || [];
    if (events.length) count += events.length;
    else if (/הכנסת כשות\s*4/.test(text)) count += 1;
  }
  return count;
}

export function isAdditionalDryHopAllowed(reportedCount: number | null): boolean {
  return reportedCount !== null && reportedCount > 0;
}
