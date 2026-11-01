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
    if (!pressure) return "לחץ במיכל: אין מדידת לחץ זמינה";
    const daysBetween = (from: string, to: string): number => {
        const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
        const [toYear, toMonth, toDay] = to.split("-").map(Number);
        return Math.round((
            Date.UTC(toYear, toMonth - 1, toDay) -
            Date.UTC(fromYear, fromMonth - 1, fromDay)
        ) / 86400000);
    };
    const daysAgo = daysBetween(pressure.date, todayDate);
    const relativeDays: Record<number, string> = {
        0: "היום",
        1: "אתמול",
        2: "לפני יומיים",
        3: "לפני שלושה ימים",
        4: "לפני ארבעה ימים",
        5: "לפני חמישה ימים",
        6: "לפני שישה ימים",
        7: "לפני שבוע",
        8: "לפני שמונה ימים",
        9: "לפני תשעה ימים",
        10: "לפני עשרה ימים",
    };
    const when = relativeDays[daysAgo] ?? `לפני ${daysAgo} ימים`;
    return daysAgo === 0
        ? `לחץ במיכל: ${pressure.value} bar`
        : `לחץ במיכל: ${pressure.value} bar (נמדד ${when})`;
}

/** Live pressure is stored separately from the immutable morning Sheet
 * measurement. It is usable for pressure advice only with a valid observation
 * timestamp; a bare tank pressure could be arbitrarily stale.
 */
export function livePressureReading(
    data: { pressure?: unknown; pressureUpdatedAt?: unknown } | null | undefined,
): LatestPressureReading | null {
    const value = numericReading(data?.pressure);
    const timestamp = String(data?.pressureUpdatedAt ?? "");
    const observedAt = timestamp ? new Date(timestamp) : null;
    if (value === null || value < 0 || !observedAt || !Number.isFinite(observedAt.getTime())) return null;
    const year = observedAt.getFullYear();
    const month = String(observedAt.getMonth() + 1).padStart(2, "0");
    const day = String(observedAt.getDate()).padStart(2, "0");
    const hours = String(observedAt.getHours()).padStart(2, "0");
    const minutes = String(observedAt.getMinutes()).padStart(2, "0");
    return { value, date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` };
}

/** Prefer the newest dated pressure source. Never replace the true current
 * tank pressure with an older morning Sheet pressure or vice versa.
 */
export function preferredPressureReading(
    measurements: CarbonationPressureReading[],
    todayDate: string,
    livePressure?: LatestPressureReading | null,
): LatestPressureReading | null {
    const history = latestPressureReading(measurements, todayDate);
    if (!livePressure || livePressure.date > todayDate) return history;
    if (!history) return livePressure;
    const key = (p: LatestPressureReading) => p.date + "_" + (p.time ?? "00:00");
    return key(livePressure) >= key(history) ? livePressure : history;
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
    livePressure?: LatestPressureReading | null,
): FirstInRangePressureAdvice | null {
    const carbEntries = datedMeasurements(measurements, todayDate)
        .map((entry) => ({ ...entry, carbonation: numericReading(entry.reading.carbonation) }))
        .filter((entry): entry is typeof entry & { carbonation: number } => entry.carbonation !== null);
    const latest = carbEntries[carbEntries.length - 1];
    if (!latest || latest.stamp.date !== todayDate || !isInRange(latest.carbonation)) return null;
    if (carbEntries.slice(0, -1).some((entry) => isInRange(entry.carbonation))) return null;
    const pressure = preferredPressureReading(measurements, todayDate, livePressure);
    if (!pressure) return null;
    if (pressure.value > 0.9) return { direction: "lower", pressure, carbonation: latest.carbonation };
    if (pressure.value < 0.5) return { direction: "raise", pressure, carbonation: latest.carbonation };
    return null;
}


/**
 * Was any actual carbonation reading in the current batch in range already?
 * Examine the complete dated history up to today, not just the latest reading.
 * A later out-of-range test must never reset the first-in-range milestone.
 */
export function hasReachedCarbonationRange(
    measurements: CarbonationPressureReading[],
    todayDate: string,
    isInRange: (carbonation: number) => boolean,
): boolean {
    return datedMeasurements(measurements, todayDate).some((entry) => {
        const carbonation = numericReading(entry.reading.carbonation);
        return carbonation !== null && isInRange(carbonation);
    });
}

export type SubsequentCarbonationPressureAdvice = {
    kind: "lower" | "raise";
    carbonation: number;
    pressure: LatestPressureReading | null;
};

/**
 * After the FIRST in-spec carbonation reading, later out-of-spec tests have a
 * specific direction instead of the original generic pre-milestone advice.
 * Once an in-range reading has occurred, any later out-of-range reading
 * produces one direction only: above target -> lower, below target -> raise.
 * The hold-pressure choice is restricted to the period up to and including
 * the first in-range reading; head pressure cannot revive it afterwards.
 *
 * Historical in-range readings must precede today's latest reading. This
 * is derived from the current batch only; a new batch restarts the milestone.
 */
export function subsequentCarbonationPressureAdvice(
    measurements: CarbonationPressureReading[],
    todayDate: string,
    isInRange: (carbonation: number) => boolean,
    target: number,
    livePressure?: LatestPressureReading | null,
): SubsequentCarbonationPressureAdvice | null {
    if (!Number.isFinite(target)) return null;
    const carbEntries = datedMeasurements(measurements, todayDate)
        .map((entry) => ({ ...entry, carbonation: numericReading(entry.reading.carbonation) }))
        .filter((entry): entry is typeof entry & { carbonation: number } => entry.carbonation !== null);
    const latest = carbEntries[carbEntries.length - 1];
    if (!latest || latest.stamp.date !== todayDate || isInRange(latest.carbonation)) return null;
    if (!carbEntries.slice(0, -1).some((entry) => isInRange(entry.carbonation))) return null;

    const pressure = preferredPressureReading(measurements, todayDate, livePressure);
    if (latest.carbonation > target) {
        return { kind: "lower", carbonation: latest.carbonation, pressure };
    }
    if (latest.carbonation < target) {
        return { kind: "raise", carbonation: latest.carbonation, pressure };
    }
    return null;
}
