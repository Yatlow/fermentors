type CellarActionMeasurement = {
    id?: string | number | null;
    notes?: string | number | null;
};

function measurementDate(id: CellarActionMeasurement["id"]): string | null {
    const text = String(id ?? "").trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:_\d{3,4})?$/);
    return match?.[1] ?? null;
}

/**
 * Completion is action-based, not "last row" based. Operators can record an
 * action and then add another measurement later on the same day; the later row
 * must not make the earlier action disappear from recommendation state.
 */
export function hasCellarActionOnDate(
    measurements: CellarActionMeasurement[],
    date: string,
    phrases: readonly string[],
): boolean {
    return measurements.some((measurement) => {
        if (measurementDate(measurement.id) !== date) return false;
        const note = String(measurement.notes ?? "");
        return phrases.some((phrase) => note.includes(phrase));
    });
}
