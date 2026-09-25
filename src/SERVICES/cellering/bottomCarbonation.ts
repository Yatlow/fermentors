export type BottomCarbonationMeasurement = {
    id?: string | number | null;
    notes?: string | number | null;
    [key: string]: unknown;
};

export type BottomCarbonationAction = {
    type: "start" | "close";
    measurement: BottomCarbonationMeasurement;
    measurementId: string;
    note: string;
    position: number;
    time?: string;
    pressure?: number;
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
    return String(note ?? "").includes("תחילת גיזוז מלמטה");
}

export function isBottomCarbonationCloseNote(note: unknown): boolean {
    return String(note ?? "").includes("סגירת גיזוז מלמטה");
}

function parseTimeNear(text: string, position: number): string | undefined {
    const slice = text.slice(position, position + 120);
    return slice.match(/(?:בשעה\s*)?(\d{1,2}:\d{2})/)?.[1];
}

function parsePressureNear(text: string, position: number, type: "start" | "close"): number | undefined {
    const nearby = text.slice(Math.max(0, position - 100), position + 150);
    const pattern = type === "start"
        ? /הורדת\s+לחץ\s+ל\s*:?-?\s*(\d+(?:[.,]\d+)?)/i
        : /על\s+(\d+(?:[.,]\d+)?)\s*bar/i;
    const match = nearby.match(pattern);
    if (!match) return undefined;
    const value = Number(match[1].replace(",", "."));
    return Number.isFinite(value) ? value : undefined;
}

export function bottomCarbonationActions(
    measurements: BottomCarbonationMeasurement[],
): BottomCarbonationAction[] {
    const actions: BottomCarbonationAction[] = [];
    const sorted = [...measurements].sort((a, b) =>
        String(a.id ?? "").localeCompare(String(b.id ?? "")),
    );

    for (const measurement of sorted) {
        const note = String(measurement.notes ?? "");
        const matcher = /תחילת גיזוז מלמטה|סגירת גיזוז מלמטה/g;
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(note)) !== null) {
            const type: "start" | "close" = match[0].startsWith("תחילת") ? "start" : "close";
            actions.push({
                type,
                measurement,
                measurementId: String(measurement.id ?? ""),
                note,
                position: match.index,
                time: parseTimeNear(note, match.index),
                pressure: parsePressureNear(note, match.index, type),
            });
        }
    }
    return actions;
}

export function findOpenBottomCarbonation(
    measurements: BottomCarbonationMeasurement[],
): BottomCarbonationMeasurement | null {
    let open: BottomCarbonationMeasurement | null = null;
    for (const action of bottomCarbonationActions(measurements)) {
        open = action.type === "start" ? action.measurement : null;
    }
    return open;
}

export function bottomCarbonationRecommendation(
    measurements: BottomCarbonationMeasurement[],
) {
    const last = bottomCarbonationActions(measurements).at(-1);
    const open = last?.type === "start";
    return {
        req: open,
        display: open,
        reason: open
            ? "גיזוז מלמטה עדיין פתוח - מומלץ לסגור ולדווח שעת סגירה ולחץ."
            : "",
        importance: open ? 2 : 0,
    };
}

function embeddedTime(segment: string): string | null {
    const match = segment.match(/(?:בשעה\s*)?(\d{1,2}):(\d{2})/);
    return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

function idDateAndMinutes(id: unknown): { date: string; minutes: number } | null {
    const match = String(id ?? "").match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/);
    if (!match) return null;
    return { date: match[1], minutes: Number(match[2]) * 60 + Number(match[3]) };
}

function minutesToClock(minutes: number): string {
    const normalized = Math.max(0, Math.min(23 * 60 + 59, minutes));
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}${String(normalized % 60).padStart(2, "0")}`;
}

/** Split a combined `a | b | c` cellar note into ordered synthetic measurements. */
export function expandCompoundCellarMeasurements<T extends BottomCarbonationMeasurement>(
    measurements: T[],
): T[] {
    return measurements.flatMap((measurement) => {
        const note = String(measurement.notes ?? "");
        let segments = note.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean);
        segments = segments.filter((segment, index) =>
            index === 0 || segment.replace(/\s+/g, " ") !== segments[index - 1].replace(/\s+/g, " ")
        );
        if (segments.length <= 1) return [{ ...measurement, notes: segments[0] ?? note } as T];

        // Bottom-carbonation start + close + the final pressure adjustment are
        // one operational cellar action even when the report stores them as
        // pipe-separated note fragments. Keep preceding/following unrelated
        // actions (for example a yeast drop) separate, but collapse the whole
        // bottom-carbonation session into one synthetic measurement.
        const startIndex = segments.findIndex(isBottomCarbonationStartNote);
        const closeIndex = segments.findIndex((segment, index) =>
            index > startIndex && isBottomCarbonationCloseNote(segment)
        );
        if (startIndex >= 0 && closeIndex > startIndex) {
            let sessionEnd = closeIndex;
            const afterClose = segments[closeIndex + 1] ?? "";
            if (/(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל/i.test(afterClose)) {
                sessionEnd = closeIndex + 1;
            }
            const session = segments.slice(startIndex, sessionEnd + 1).join(" | ");
            segments = [
                ...segments.slice(0, startIndex),
                session,
                ...segments.slice(sessionEnd + 1),
            ];
        }

        const base = idDateAndMinutes(measurement.id);
        let cursor = base?.minutes ?? 0;

        return segments.map((segment, index) => {
            const explicit = embeddedTime(segment);
            if (explicit) {
                const [hour, minute] = explicit.split(":").map(Number);
                cursor = hour * 60 + minute;
            } else if (index > 0) {
                cursor += 1;
            }

            const split = {
                ...measurement,
                id: base ? `${base.date}_${minutesToClock(cursor)}` : measurement.id,
                notes: segment,
            } as T;

            // Numeric measurements belong to the physical reading, not to every
            // action that happened to be concatenated into its note field.
            if (index > 0) {
                for (const key of ["temp", "plato", "pH", "pressure", "carbonation", "volume"] as const) {
                    if (key in split) (split as Record<string, unknown>)[key] = undefined;
                }
            }
            return split;
        });
    });
}
