/**
 * A yeast drop can unlock a cooling recommendation no earlier than the next
 * calendar day. Only completed actions in the current batch count; mentioning
 * yeast in an instruction or recommendation is not evidence of a completed drop.
 */
export type CoolingYeastMeasurement = {
    id?: string | number | null;
    notes?: string | number | null;
};

function isCompletedYeastDrop(note: unknown): boolean {
    return String(note ?? "").split(/[|;\n]/).some((part) =>
        /^(?:הורדת|הורדתי|הורדו|הוצאת|הוצאתי)\s+(?:(?:\d+(?:[.,]\d+)?\s+)?(?:דלי(?:י|ים)?\s+)?(?:של\s+)?)?(?:שמרים|שמרי)(?:$|[\s,:])/u.test(part.trim())
    );
}

export function latestCompletedYeastDropDate(
    measurements: CoolingYeastMeasurement[],
    todayDate: string,
): string | null {
    const dates = measurements.flatMap((reading) => {
        if (!isCompletedYeastDrop(reading.notes)) return [];
        const match = /^(\d{4}-\d{2}-\d{2})(?:_\d{3,4})?$/.exec(String(reading.id ?? "").trim());
        return match && match[1] <= todayDate ? [match[1]] : [];
    });
    return dates.length ? dates.sort().at(-1)! : null;
}

/** True only from the day AFTER the most recent completed yeast drop. */
export function yeastDropAllowsCooling(
    measurements: CoolingYeastMeasurement[],
    todayDate: string,
): boolean {
    const lastDropDate = latestCompletedYeastDropDate(measurements, todayDate);
    return lastDropDate !== null && lastDropDate < todayDate;
}
