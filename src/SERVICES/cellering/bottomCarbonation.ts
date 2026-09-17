export type BottomCarbonationMeasurement = {
    id?: string | number | null;
    notes?: string | number | null;
};

export const DEFAULT_BOTTOM_CARBONATION_PRESSURE = 0.2;

export function formatClockTime(date: Date = new Date()): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function buildBottomCarbonationStartNote(
    pressure: number | string = DEFAULT_BOTTOM_CARBONATION_PRESSURE,
    time: string = formatClockTime(),
): string {
    return `הורדת לחץ ל${pressure} bar. תחילת גיזוז מלמטה בשעה ${time}`;
}

export function buildBottomCarbonationCloseNote(
    pressure: number | string,
    time: string = formatClockTime(),
): string {
    return `סגירת גיזוז מלמטה בשעה ${time} על ${pressure} bar.`;
}

export function isBottomCarbonationStartNote(note: unknown): boolean {
    const text = String(note ?? "");
    return text.includes("תחילת גיזוז מלמטה");
}

export function isBottomCarbonationCloseNote(note: unknown): boolean {
    const text = String(note ?? "");
    return text.includes("סגירת גיזוז מלמטה");
}

export function findOpenBottomCarbonation(
    measurements: BottomCarbonationMeasurement[],
): BottomCarbonationMeasurement | null {
    const sorted = [...measurements].sort((a, b) =>
        String(a.id ?? "").localeCompare(String(b.id ?? "")),
    );

    let open: BottomCarbonationMeasurement | null = null;
    for (const measurement of sorted) {
        if (isBottomCarbonationStartNote(measurement.notes)) open = measurement;
        if (isBottomCarbonationCloseNote(measurement.notes)) open = null;
    }
    return open;
}
