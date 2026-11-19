/** Formatting only; reuse already-loaded daily readings without extra Firestore reads. */
export function completedCellarMeasurementDetails(
  rows: ReadonlyArray<{ notes?: unknown; carbonation?: unknown }>,
): { yeast?: string; carbonation?: string } {
  const buckets: number[] = [];
  const carbResults: number[] = [];
  for (const row of rows) {
    const notes = String(row.notes ?? "");
    const regex = /הורדת\s+(\d+(?:[.,]\d+)?)\s+דל(?:יי|י|יים)\s+שמרים/g;
    for (const match of notes.matchAll(regex)) {
      const count = Number(match[1].replace(",", "."));
      if (Number.isFinite(count) && count > 0) buckets.push(count);
    }
    if (row.carbonation !== null && row.carbonation !== undefined &&
        String(row.carbonation).trim() !== "") {
      const value = Number(row.carbonation);
      if (Number.isFinite(value) && value >= 0) carbResults.push(value);
    }
  }
  const yeastTotal = buckets.reduce((total, value) => total + value, 0);
  return {
    ...(buckets.length ? { yeast: `${yeastTotal.toLocaleString("he-IL")} דליי שמרים` } : {}),
    ...(carbResults.length ? {
      carbonation: `${carbResults.map((result) => result.toFixed(2)).join(" / ")} vol`,
    } : {}),
  };
}
