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
 * A carbonation-driven pressure adjustment is a SAME-DAY workflow.
 * Test and action can share a journal row or be stored on different rows
 * without reliable ordering. Never attribute today's action to an old
 * carbonation result, even if that was the last preceding row.
 * The current-batch measurements are already loaded by the caller.
 */
type CarbonationPressureMeasurement = CellarActionMeasurement & {
    carbonation?: string | number | null;
};

function chronologicalKey(id: CellarActionMeasurement["id"]): string | null {
    const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{3,4}))?$/);
    return match ? `${match[1]}_${(match[2] ?? "0000").padStart(4, "0")}` : null;
}

export type CarbonationPressureAdjustmentEvidence = {
    carbonation: number;
    /** This action followed the first actual in-spec test in this batch. */
    firstInRange: boolean;
};

/** One completed pressure action per tank/day, associated with the latest
 * actual carbonation measured on THAT day (not the preceding journal row).
 * In-spec history from prior days is only used to identify whether today
 * represents the first arrival in range for this batch.
 */
export function carbonationPressureAdjustmentEvidenceOnDate(
    measurements: CarbonationPressureMeasurement[],
    date: string,
    isInRange: (carbonation: number) => boolean,
): CarbonationPressureAdjustmentEvidence | null {
    const ordered = measurements
        .map((measurement) => ({ measurement, order: chronologicalKey(measurement.id) }))
        .filter((row): row is { measurement: CarbonationPressureMeasurement; order: string } => row.order !== null && row.order.slice(0, 10) <= date)
        .sort((a, b) => a.order.localeCompare(b.order));

    const todayRows = ordered.filter((row) => row.order.slice(0, 10) === date);
    // A real adjustment report is needed; pressure measurements or packaging
    // pressure notes are not cellar pressure actions.
    if (!todayRows.some((row) => isCellarPressureActionNote(row.measurement.notes))) return null;

    const validCarbonation = (raw: unknown): number | null => {
        if (raw === null || raw === undefined || String(raw).trim() === "") return null;
        const value = Number(String(raw).trim().replace(",", "."));
        return Number.isFinite(value) ? value : null;
    };
    const todayTests = todayRows
        .map((row) => validCarbonation(row.measurement.carbonation))
        .filter((value): value is number => value !== null);
    if (!todayTests.length) return null;

    const latestToday = todayTests[todayTests.length - 1];
    const inRangeOnEarlierDay = ordered.some((row) =>
        row.order.slice(0, 10) < date &&
        ((value) => value !== null && isInRange(value))(validCarbonation(row.measurement.carbonation))
    );
    return {
        carbonation: latestToday,
        firstInRange: isInRange(latestToday) && !inRangeOnEarlierDay,
    };
}

/** Backward-compatible numeric helper for existing callers. */
export function completedCarbonationPressureAdjustmentOnDate(
    measurements: CarbonationPressureMeasurement[],
    date: string,
): number | null {
    return carbonationPressureAdjustmentEvidenceOnDate(measurements, date, () => false)?.carbonation ?? null;
}
