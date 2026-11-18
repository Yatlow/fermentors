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
 * Packaging reports may append an operational 'הורדת לחץ' measurement when
 * recording kegs/bottles. It must not count as an independent cellar pressure
 * adjustment (or complete a scheduled cellar pressure recommendation).
 */
export function isCellarPressureActionNote(notes: unknown): boolean {
    const note = String(notes ?? "");
    if (/(?:^|[|,\n])\s*הורדת\s+[\d.,]+\s+(?:חביות|בקבוקים)(?:\s|$|[,|])/u.test(note)) return false;
    return /(?:העלאת|הורדת)\s+לחץ/.test(note);
}

/**
 * Associate a physical pressure change with the latest carbonation test at
 * that action, including a reading on the SAME measurement row. The brew sheet
 * keeps the morning reading immutable while actions are appended to its note,
 * so requiring a preceding document misses legitimate adjustments.
 * The latest completed action wins if several adjustments occurred today.
 * No fabricated measurement, note rewrite, or extra Firestore read is needed.
 * The caller supplies measurements for only the current batch.
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
    let latestActionCarbonation: number | null = null;
    for (const { measurement, order } of ordered) {
        const day = order.slice(0, 10);
        if (day > date) break;

        const raw = measurement.carbonation;
        const parsed = raw === null || raw === undefined || String(raw).trim() === ""
            ? null : Number(String(raw).replace(",", "."));
        const sameRowCarbonation = parsed !== null && Number.isFinite(parsed)
            ? parsed : null;

        // Quick reports can append a pressure adjustment to the very same
        // row as the test it follows. In that case the row's actual test takes
        // precedence over yesterday's / an earlier test (e.g. 2.36 -> 2.44).
        if (day === date && isCellarPressureActionNote(measurement.notes)) {
            const relevantCarbonation = sameRowCarbonation ?? previousCarbonation;
            if (relevantCarbonation !== null) latestActionCarbonation = relevantCarbonation;
        }

        if (sameRowCarbonation !== null) previousCarbonation = sameRowCarbonation;
    }
    return latestActionCarbonation;
}
