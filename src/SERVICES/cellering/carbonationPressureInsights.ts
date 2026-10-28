/**
 * Read-only carbonation/pressure insights from the current batch history.
 * No one-shot state is persisted; the first valid carbonation result is
 * determined by checking all earlier actual carbonation measurements.
 */
export type CarbonationPressureReading = {
    id?: string | number | null;
    carbonation?: string | number | null;
    pressure?: string | number | null;
};

export type LatestPressureReading = {
    value: number;
    date: string;
    time: string | null;
};

function measurementIdentity(id: unknown): { date: string; key: string; time: string | null } | null {
    const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{3,4}))?$/);
    if (!match) return null;
    const hourMinute = match[2]?.padStart(4, "0") ?? null;
    return {
        date: match[1],
        key: `${match[1]}_${hourMinute ?? "0000"}`,
        time: hourMinute ? `${hourMinute.slice(0, 2)}:${hourMinute.slice(2)}` : null,
    };
}

function numericReading(value: unknown): number | null {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(String(value).replace(",", "."));
    return Number.isFinite(number) ? number : null;
}

function datedMeasurements<T extends CarbonationPressureReading>(measurements: T[], todayDate: string) {
    return measurements
        .map((reading) => ({ reading, stamp: measurementIdentity(reading.id) }))
        .filter((entry): entry is { reading: T; stamp: NonNullable<typeof entry.stamp> } =>
            entry.stamp !== null && entry.stamp.date <= todayDate)
        .sort((a, b) => a.stamp.key.localeCompare(b.stamp.key));
}

export function latestPressureReading(
    measurements: CarbonationPressureReading[],
    todayDate: string,
): LatestPressureReading | null {
    const entries = datedMeasurements(measurements, todayDate);
    for (let i = entries.length - 1; i >= 0; i--) {
        const value = numericReading(entries[i].reading.pressure);
        if (value !== null) {
            return { value, date: entries[i].stamp.date, time: entries[i].stamp.time };
        }
    }
    return null;
}

export function carbonationPressureContext(
    measurements: CarbonationPressureReading[],
    todayDate: string,
): string {
    const pressure = latestPressureReading(measurements, todayDate);
    if (!pressure) return "לחץ אחרון: אין מדידת לחץ זמינה";
    const formattedDate = pressure.date.split("-").reverse().join("/");
    const when = pressure.date === todayDate
        ? `היום${pressure.time ? ` בשעה ${pressure.time}` : ""}`
        : `נמדד ב־${formattedDate}${pressure.time ? ` בשעה ${pressure.time}` : ""}`;
    return `לחץ אחרון: ${pressure.value} bar (${when})`;
}

export type FirstInRangePressureAdvice = {
    direction: "raise" | "lower";
    pressure: LatestPressureReading;
    carbonation: number;
};

/** Only the first ever in-range carbonation measurement, made today, qualifies. */
export function firstInRangePressureAdvice(
    measurements: CarbonationPressureReading[],
    todayDate: string,
    isInRange: (carbonation: number) => boolean,
): FirstInRangePressureAdvice | null {
    const carbEntries = datedMeasurements(measurements, todayDate)
        .map((entry) => ({ ...entry, carbonation: numericReading(entry.reading.carbonation) }))
        .filter((entry): entry is typeof entry & { carbonation: number } => entry.carbonation !== null);
    const latest = carbEntries[carbEntries.length - 1];
    if (!latest || latest.stamp.date !== todayDate || !isInRange(latest.carbonation)) return null;
    if (carbEntries.slice(0, -1).some((entry) => isInRange(entry.carbonation))) return null;
    const pressure = latestPressureReading(measurements, todayDate);
    if (!pressure) return null;
    if (pressure.value > 0.9) return { direction: "lower", pressure, carbonation: latest.carbonation };
    if (pressure.value < 0.5) return { direction: "raise", pressure, carbonation: latest.carbonation };
    return null;
}
