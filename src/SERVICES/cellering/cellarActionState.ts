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

/**
 * Attribute a physical pressure change to a carbonation test only when a real
 * carbonation reading in this batch chronologically precedes the action.
 * No note rewrite, marker, out-of-spec requirement, or UI origin is needed.
 * The caller fetches measurements for ONE batch and only scores today's action.
 */
type CarbonationPressureMeasurement = CellarActionMeasurement & {
    carbonation?: string | number | null;
};

function chronologicalKey(id: CellarActionMeasurement["id"]): string | null {
    const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{3,4}))?$/);
    return match ? `${match[1]}_${(match[2] ?? "0000").padStart(4, "0")}` : null;
}

export function completedCarbonationPressureAdjustmentOnDate(
    measurements: CarbonationPressureMeasurement[],
    date: string,
): number | null {
    const ordered = measurements
        .map((measurement) => ({ measurement, order: chronologicalKey(measurement.id) }))
        .filter((row): row is { measurement: CarbonationPressureMeasurement; order: string } => row.order !== null)
        .sort((a, b) => a.order.localeCompare(b.order));

    let previousCarbonation: number | null = null;
    for (const { measurement, order } of ordered) {
        const day = order.slice(0, 10);
        if (day > date) break;

        const note = String(measurement.notes ?? "");
        // Check the action BEFORE reading carbonation from this row: a test and
        // action in the same undifferentiated row do not prove which came first.
        if (day === date && previousCarbonation !== null &&
            /(?:העלאת|הורדת)\s+לחץ/.test(note)) {
            return previousCarbonation;
        }

        const raw = measurement.carbonation;
        if (raw === null || raw === undefined || String(raw).trim() === "") continue;
        const carbonation = Number(String(raw).replace(",", "."));
        if (Number.isFinite(carbonation)) previousCarbonation = carbonation;
    }
    return null;
}
