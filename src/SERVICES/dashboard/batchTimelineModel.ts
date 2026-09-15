export type TimelineMeasurement = {
    id?: string | number | null;
    date?: unknown;
    time?: unknown;
    temp?: unknown;
    plato?: unknown;
    pH?: unknown;
    pressure?: unknown;
    carbonation?: unknown;
    notes?: unknown;
};

export type TimelineEventType =
    | "brew"
    | "dryhop"
    | "yeast"
    | "diacetyl"
    | "pressure"
    | "cooling"
    | "carbonation"
    | "packaging";

export type TimelineEvent = {
    id: string;
    type: TimelineEventType;
    label: string;
    icon: string;
    date: Date;
    dateLabel: string;
    timeLabel?: string;
    brewAge: number | null;
    note?: string;
    detail?: string;
};

export type YeastAmountParser = (notes: string | number | null | undefined) => number | null;

const DAY_MS = 24 * 60 * 60 * 1000;

function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== "";
}

function numericValue(value: unknown): number | null {
    if (!hasValue(value)) return null;
    const number = Number(String(value).replace(",", "."));
    return Number.isFinite(number) ? number : null;
}

function prettyNumber(value: number): string {
    return String(Number(value.toFixed(2)));
}

export function parseBrewDate(value?: string | null): Date | null {
    if (!value) return null;
    const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!match) return null;

    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
    date.setHours(0, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function measurementDateTime(measurement: TimelineMeasurement): Date | null {
    const id = String(measurement.id ?? "").trim();
    const idMatch = id.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/);
    if (idMatch) {
        const date = new Date(
            Number(idMatch[1]),
            Number(idMatch[2]) - 1,
            Number(idMatch[3]),
            Number(idMatch[4]),
            Number(idMatch[5])
        );
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const dateMatch = String(measurement.date ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!dateMatch) return null;

    let year = Number(dateMatch[3]);
    if (year < 100) year += 2000;
    const timeMatch = String(measurement.time ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
    const date = new Date(
        year,
        Number(dateMatch[2]) - 1,
        Number(dateMatch[1]),
        timeMatch ? Number(timeMatch[1]) : 0,
        timeMatch ? Number(timeMatch[2]) : 0
    );
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date: Date): string {
    return date.toLocaleDateString("he-IL", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

function brewAgeAt(date: Date, brewDate: Date | null): number | null {
    if (!brewDate) return null;
    const eventDay = new Date(date);
    const brewDay = new Date(brewDate);
    eventDay.setHours(0, 0, 0, 0);
    brewDay.setHours(0, 0, 0, 0);
    const days = Math.round((eventDay.getTime() - brewDay.getTime()) / DAY_MS);
    return days >= 0 ? days : null;
}

function pressureTarget(notes: string): number | null {
    const match = notes.match(/(?:העלאת|הורדת|להעלות|להוריד|שינוי)\s+לחץ\s+ל\s*:?\s*-?\s*(\d+(?:[.,]\d+)?)/i);
    return match ? numericValue(match[1]) : null;
}

function reliefTarget(notes: string): number | null {
    const match = notes.match(/כיוון\s+פורק\s+ל\s*:?\s*-?\s*(\d+(?:[.,]\d+)?)/i);
    return match ? numericValue(match[1]) : null;
}

function yeastPressureAfter(notes: string): number | null {
    const match = notes.match(/לחץ\s+אחרי\s*(\d+(?:[.,]\d+)?)\s*bar/i);
    return match ? numericValue(match[1]) : null;
}

function fallbackYeastAmount(notes: string | number | null | undefined): number | null {
    const match = String(notes ?? "").match(/(?:הורדת|הוצאת)\s+(\d+(?:[.,]\d+)?)\s+דל/i);
    return match ? numericValue(match[1]) : null;
}

function dryHopDetail(notes: string): string | undefined {
    const details: string[] = [];
    const hops = notes.match(/(\d+(?:[.,]\d+)?)\s*גרם\s+של\s+([^.,|]+)/i);
    if (hops) details.push(`${hops[1].replace(",", ".")} גרם ${hops[2].trim()}`);

    const relief = reliefTarget(notes);
    if (relief !== null) details.push(`פורק ל־${prettyNumber(relief)} bar`);
    return details.length ? details.join(" · ") : undefined;
}

function previousPressure(rows: TimelineMeasurement[], currentIndex: number): number | null {
    const current = numericValue(rows[currentIndex]?.pressure);
    if (current !== null) return current;

    for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const pressure = numericValue(rows[index]?.pressure);
        if (pressure !== null) return pressure;
    }
    return null;
}

type CarbonationReading = {
    value: number;
    index: number;
    measurementId: string;
};

function previousCarbonationReading(
    rows: TimelineMeasurement[],
    currentIndex: number
): CarbonationReading | null {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const carbonation = numericValue(rows[index]?.carbonation);
        if (carbonation !== null) {
            return {
                value: carbonation,
                index,
                measurementId: String(rows[index]?.id ?? index),
            };
        }
    }
    return null;
}

function removeStandaloneCarbonationEvent(events: TimelineEvent[], measurementId: string): void {
    const eventId = `carbonation-${measurementId}`;
    const eventIndex = events.findIndex((event) => event.id === eventId);
    if (eventIndex >= 0) events.splice(eventIndex, 1);
}

function eventBase(
    id: string,
    type: TimelineEventType,
    label: string,
    icon: string,
    date: Date,
    brewDate: Date | null,
    note?: string,
    detail?: string
): TimelineEvent {
    return {
        id,
        type,
        label,
        icon,
        date,
        dateLabel: formatDate(date),
        timeLabel: formatTime(date),
        brewAge: brewAgeAt(date, brewDate),
        note,
        detail,
    };
}

export function buildBatchTimeline(
    measurements: TimelineMeasurement[],
    brewDateValue?: string | null,
    parseYeastAmount: YeastAmountParser = fallbackYeastAmount
): TimelineEvent[] {
    const brewDate = parseBrewDate(brewDateValue);
    const events: TimelineEvent[] = [];

    if (brewDate) {
        events.push(eventBase("brew-start", "brew", "בישול", "🍺", brewDate, brewDate));
    }

    const rows = [...measurements].sort((a, b) =>
        String(a.id ?? "").localeCompare(String(b.id ?? ""))
    );
    let coolingWasRecorded = false;

    rows.forEach((measurement, index) => {
        const date = measurementDateTime(measurement);
        if (!date) return;

        const measurementId = String(measurement.id ?? index);
        const note = String(measurement.notes ?? "").trim();
        const carbonation = numericValue(measurement.carbonation);

        // Start by recording every carbonation test. If a pressure correction
        // later consumes that result, its standalone bubble is removed and the
        // result is shown inside the pressure event instead. This avoids showing
        // one physical test twice on the timeline.
        if (carbonation !== null) {
            events.push(eventBase(
                `carbonation-${measurementId}`,
                "carbonation",
                "בדיקת גיזוז",
                "🫧",
                date,
                brewDate,
                note || undefined,
                `תוצאה ${prettyNumber(carbonation)} vol`
            ));
        }

        if (!note) return;

        const hasDryHop = /דרייהופ|דריי\s*הופ|הכנסת\s*כשות/i.test(note);
        const hasClosure = /סגירת\s*(?:מיכל|לחץ|נשם)?|סגירה/i.test(note);
        const hasYeast = /שמרים|הורדת\s*שמר|הוצאת\s*שמר/i.test(note);
        const hasDiacetyl = /דיאציטיל|מנוחת\s*דיאציטיל|חימום\s*מיכל/i.test(note);
        const hasCooling = /קירור|קורר|קירר/i.test(note);
        const hasPackaging = /אריז|בקבוק|בקבוקים|חביות|חבית/i.test(note);
        const targetPressure = pressureTarget(note);
        const targetRelief = reliefTarget(note);
        const hasExplicitPressureChange = /(?:העלאת|הורדת|להעלות|להוריד|שינוי)\s+לחץ/i.test(note);

        if (hasDryHop) {
            events.push(eventBase(
                `dryhop-${measurementId}`,
                "dryhop",
                hasClosure ? "דרייהופ + סגירת לחץ" : "דרייהופ",
                "🌿",
                date,
                brewDate,
                note,
                dryHopDetail(note)
            ));
        }

        if (hasYeast) {
            const details: string[] = [];
            const amount = parseYeastAmount(note);
            if (amount !== null && Number.isFinite(amount)) details.push(`${prettyNumber(amount)} דליים`);
            const pressureAfter = yeastPressureAfter(note);
            if (pressureAfter !== null) details.push(`לחץ אחרי ${prettyNumber(pressureAfter)} bar`);
            events.push(eventBase(
                `yeast-${measurementId}`,
                "yeast",
                "הורדת שמרים",
                "🪣",
                date,
                brewDate,
                note,
                details.length ? details.join(" · ") : undefined
            ));
        }

        if (hasDiacetyl) {
            events.push(eventBase(
                `diacetyl-${measurementId}`,
                "diacetyl",
                "מנוחת דיאציטיל",
                "♨️",
                date,
                brewDate,
                note,
                /14\s*°/.test(note) ? "חימום ל־14°" : undefined
            ));
        }

        if (hasCooling) {
            events.push(eventBase(
                `cooling-${measurementId}`,
                "cooling",
                "קירור",
                "❄️",
                date,
                brewDate,
                note
            ));
        }

        if (hasPackaging) {
            events.push(eventBase(
                `packaging-${measurementId}`,
                "packaging",
                "אריזה",
                "📦",
                date,
                brewDate,
                note
            ));
        }

        // Dry-hop closure is intentionally one combined lifecycle event rather
        // than two adjacent cards saying the same thing.
        if (hasClosure && !hasDryHop) {
            const details: string[] = [];
            if (targetRelief !== null) details.push(`פורק ל־${prettyNumber(targetRelief)} bar`);
            events.push(eventBase(
                `pressure-close-${measurementId}`,
                "pressure",
                "סגירת לחץ",
                "gauge",
                date,
                brewDate,
                note,
                details.length ? details.join(" · ") : undefined
            ));
        } else if (hasExplicitPressureChange || (!hasClosure && targetRelief !== null)) {
            const before = previousPressure(rows, index);
            const previousCarbonation = previousCarbonationReading(rows, index);
            const carbonationSource: CarbonationReading | null = carbonation !== null
                ? { value: carbonation, index, measurementId }
                : previousCarbonation;
            const isCarbonationCorrection = hasExplicitPressureChange &&
                carbonationSource !== null &&
                (carbonation !== null || coolingWasRecorded);
            const details: string[] = [];

            if (isCarbonationCorrection && carbonationSource) {
                // The pressure event already carries the test result, so hide the
                // separate carbonation bubble that would otherwise duplicate it.
                removeStandaloneCarbonationEvent(events, carbonationSource.measurementId);
                details.push(`גיזוז: ${prettyNumber(carbonationSource.value)} vol`);
                if (before !== null) details.push(`לחץ לפני: ${prettyNumber(before)} bar`);
                if (targetPressure !== null) details.push(`לחץ חדש: ${prettyNumber(targetPressure)} bar`);
                if (targetRelief !== null) details.push(`פורק: ${prettyNumber(targetRelief)} bar`);
            } else {
                if (targetPressure !== null) details.push(`לחץ: ${prettyNumber(targetPressure)} bar`);
                if (targetRelief !== null) details.push(`פורק: ${prettyNumber(targetRelief)} bar`);
            }

            const label = isCarbonationCorrection
                ? "שינוי לחץ בעקבות גיזוז"
                : targetPressure !== null && targetRelief !== null
                    ? "שינוי לחץ וכיוון פורק"
                    : targetPressure !== null
                        ? "שינוי לחץ"
                        : "כיוון פורק";

            events.push(eventBase(
                `pressure-change-${measurementId}`,
                "pressure",
                label,
                "gauge",
                date,
                brewDate,
                note,
                details.length ? details.join("\n") : undefined
            ));
        }

        if (hasCooling) coolingWasRecorded = true;
    });

    const unique = new Map<string, TimelineEvent>();
    events
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .forEach((event) => {
            const dayKey = `${event.date.getFullYear()}-${event.date.getMonth() + 1}-${event.date.getDate()}`;
            const preserveEveryOccurrence = event.type === "yeast" ||
                event.type === "carbonation" ||
                event.type === "pressure";
            const key = preserveEveryOccurrence ? event.id : `${event.type}-${dayKey}`;
            if (!unique.has(key)) unique.set(key, event);
        });

    return [...unique.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}
