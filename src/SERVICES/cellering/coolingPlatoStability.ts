export type PlatoCoolingMeasurement = { id?: string | number | null; time?: string | number | null; plato?: string | number | null };

/**
 * Cooling readiness is based on dated Plato samples, never unrelated pressure
 * or temperature reports. Two equal samples at least 48h apart suffice; the
 * original three-sample route also remains available. Any intervening Plato
 * change blocks both routes. The latest valid Plato must be measured today,
 * not just within the past 24h: a pressure-only report cannot clear this guard.
 */
export function hasStablePlatoForCooling(
    measurements: PlatoCoolingMeasurement[],
    now: Date = new Date(),
): boolean {
    const samples = measurements.flatMap((measurement) => {
        const raw = measurement.plato;
        if (raw === null || raw === undefined || String(raw).trim() === "") return [];
        const value = Number(raw);
        if (!Number.isFinite(value)) return [];
        const match = /^(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})(\d{2}))?$/.exec(String(measurement.id ?? ""));
        if (!match) return [];
        const [, year, month, day] = match;
        const clock = String(measurement.time ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
        // Canonical date-only IDs MUST use the actual Sheet time field.
        // Otherwise we cannot safely assert the sample is newer than 24h.
        if (!match[4] && !clock) return [];
        const hour = clock?.[1] ?? match[4] ?? "00";
        const minute = clock?.[2] ?? match[5] ?? "00";
        const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
        if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 ||
            date.getDate() !== Number(day) || date.getHours() !== Number(hour) ||
            date.getMinutes() !== Number(minute)) return [];
        return [{ date: date.getTime(), value }];
    }).sort((a, b) => a.date - b.date);
    if (samples.length < 2) return false;
    const latest = samples[samples.length - 1];
    const latestDate = new Date(latest.date);
    if (latestDate.getFullYear() !== now.getFullYear() ||
        latestDate.getMonth() !== now.getMonth() ||
        latestDate.getDate() !== now.getDate()) return false;
    const age = now.getTime() - latest.date;
    if (age < 0 || age > 24 * 60 * 60 * 1000) return false;
    // Find the earliest point in the uninterrupted equal-Plato suffix.
    let start = samples.length - 1;
    while (start > 0 && samples[start - 1].value === latest.value) start--;
    const stable = samples.slice(start);
    const threeReadings = stable.length >= 3 && stable[0].date < latest.date;
    const weekendGap = stable.length >= 2 &&
        latest.date - stable[0].date >= 48 * 60 * 60 * 1000;
    return threeReadings || weekendGap;
}

