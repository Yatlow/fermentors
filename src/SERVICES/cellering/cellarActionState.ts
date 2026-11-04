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
 * A plain pressure change is not evidence that an out-of-spec carbonation
 * test caused it. Only an explicitly attributed report, recorded after an
 * actual failed test in this batch, may earn carbonation-treatment credit.
 */
export const FAILED_CARBONATION_PRESSURE_NOTE = " (בעקבות בדיקת גיזוז לא תקינה)";

type CarbonationPressureMeasurement = CellarActionMeasurement & {
    carbonation?: string | number | null;
};

function chronologicalKey(id: CellarActionMeasurement["id"]): string {
    const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{3,4}))?$/);
    return match ? `${match[1]}_${(match[2] ?? "0000").padStart(4, "0")}` : "";
}

export function completedCarbonationPressureAdjustmentOnDate(
    measurements: CarbonationPressureMeasurement[],
    date: string,
    isOutOfSpec: (carbonation: number) => boolean,
): number | null {
    const ordered = [...measurements].sort((a, b) =>
        chronologicalKey(a.id).localeCompare(chronologicalKey(b.id))
    );
    let latestFailedCarbonation: number | null = null;

    for (const measurement of ordered) {
        const measurementDay = measurementDate(measurement.id);
        if (!measurementDay || measurementDay > date) continue;

        const rawCarb = measurement.carbonation;
        if (rawCarb !== null && rawCarb !== undefined && String(rawCarb).trim() !== "") {
            const carbonation = Number(String(rawCarb).replace(",", "."));
            if (Number.isFinite(carbonation)) {
                // A subsequent in-range test cancels the old failed-test context.
                latestFailedCarbonation = isOutOfSpec(carbonation) ? carbonation : null;
            }
        }

        if (measurementDay !== date || latestFailedCarbonation === null) continue;
        const note = String(measurement.notes ?? "");
        if (!note.includes(FAILED_CARBONATION_PRESSURE_NOTE.trim())) continue;
        if (!/(?:העלאת|הורדת|להעלות|להוריד)\s+לחץ/.test(note)) continue;

        return latestFailedCarbonation;
    }
    return null;
}
