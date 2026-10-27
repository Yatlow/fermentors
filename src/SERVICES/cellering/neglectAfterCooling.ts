/**
 * Neglect is a cold-cellar rule. The five-day clock cannot begin before the
 * latest documented cooling event, regardless of earlier fermentation actions.
 * Only actual post-cooling carbonation tests / yeast drops may reset it.
 */
export type ColdNeglectMeasurement = {
    id?: string | number | null;
    time?: string | number | null;
    notes?: string | number | null;
    carbonation?: string | number | null;
};

type RecordedMoment = {
    at: Date;
    dateLabel: string;
    timeLabel: string | null;
};

export type ColdNeglectResult = {
    importance: 2 | 3;
    reason: string;
};

function parseTime(value: string): { hour: number; minute: number } | null {
    const trimmed = value.trim();
    const colon = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    const compact = /^(\d{3,4})$/.exec(trimmed);
    if (!colon && !compact) return null;
    const hour = colon ? Number(colon[1]) : Number(compact![1].slice(0, -2));
    const minute = colon ? Number(colon[2]) : Number(compact![1].slice(-2));
    return hour <= 23 && minute <= 59
        ? { hour, minute }
        : null;
}

function recordedMoment(measurement: ColdNeglectMeasurement): RecordedMoment | null {
    const id = String(measurement.id ?? "").trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:_(\d{3,4}))?$/.exec(id);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const rawTime = match[4] ?? String(measurement.time ?? "");
    const parsedTime = parseTime(rawTime);
    // When only a calendar date exists, midnight is used for eligibility,
    // but no hour is invented in the recommendation text.
    const hour = parsedTime?.hour ?? 0;
    const minute = parsedTime?.minute ?? 0;
    const at = new Date(year, month - 1, day, hour, minute);
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 ||
        at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) {
        return null;
    }
    return {
        at,
        dateLabel: `${match[3]}/${match[2]}/${match[1]}`,
        timeLabel: parsedTime
            ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
            : null,
    };
}

function hasActualCooling(notes: string): boolean {
    return notes.split(/[|;\n]/).some((part) =>
        /^(?:קירור(?:$|\s+מיכל|\s+ל\s*\d)|התחלת קירור|(?:המיכל\s+)?הועבר לקירור|(?:המיכל\s+)?הוחזר לקירור|חזרה לקירור|החזרה לקירור)/.test(part.trim())
    );
}

function hasActualYeastDrop(notes: string): boolean {
    return notes.split(/[|;\n]/).some((part) =>
        /^(?:הורדת שמרים|הורדת שמרי|הורדו שמרים|הורדתי שמרים|הוצאת שמרים)/.test(part.trim())
    );
}

function hasCarbonationTest(value: ColdNeglectMeasurement["carbonation"]): boolean {
    return value !== null && value !== undefined && value !== "" &&
        Number.isFinite(Number(value));
}

function fiveOrSevenDaysLater(moment: RecordedMoment, days: number): Date {
    const deadline = new Date(moment.at);
    deadline.setDate(deadline.getDate() + days);
    return deadline;
}

/** Returns null if there is no documented cooling or fewer than five days of neglect. */
export function evaluateColdTankNeglect(
    measurements: ColdNeglectMeasurement[],
    now: Date = new Date(),
): ColdNeglectResult | null {
    const events = measurements
        .map((measurement) => ({
            measurement,
            moment: recordedMoment(measurement),
            notes: String(measurement.notes ?? ""),
        }))
        .filter((event): event is typeof event & { moment: RecordedMoment } => event.moment !== null);

    const cooling = events
        .filter((event) => hasActualCooling(event.notes))
        .sort((a, b) => b.moment.at.getTime() - a.moment.at.getTime())[0];
    if (!cooling || cooling.moment.at > now) return null;

    const laterActions = events
        .filter((event) => event.moment.at >= cooling.moment.at)
        .filter((event) =>
            hasActualYeastDrop(event.notes) || hasCarbonationTest(event.measurement.carbonation)
        )
        .sort((a, b) => b.moment.at.getTime() - a.moment.at.getTime());
    const anchor = laterActions[0]?.moment ?? cooling.moment;
    if (anchor.at > now || now < fiveOrSevenDaysLater(anchor, 5)) return null;

    const importance: 2 | 3 =
        laterActions.length === 0 || now > fiveOrSevenDaysLater(anchor, 7) ? 3 : 2;

    return {
        importance,
        reason: `⚠️ המיכל מוזנח מ־${anchor.dateLabel}${anchor.timeLabel ? ` בשעה ${anchor.timeLabel}` : ""}, הוא דורש תשומת לב. מומלץ לבדוק צורך בבדיקת גיזוז ובהורדת שמרים.`,
    };
}
