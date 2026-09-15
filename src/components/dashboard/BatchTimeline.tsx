import { useMemo } from "react";
import type { Measurement } from "../../SERVICES/cellering/calculateCelleringRecomendations";
import "./BatchTimeline.css";

type Props = {
    measurements: Measurement[];
    brewDate?: string | null;
};

type TimelineEventType =
    | "brew"
    | "dryhop"
    | "yeast"
    | "diacetyl"
    | "pressure"
    | "cooling"
    | "carbonation"
    | "packaging";

type TimelineEvent = {
    id: string;
    type: TimelineEventType;
    label: string;
    icon: string;
    date: Date;
    dateLabel: string;
    timeLabel?: string;
    brewAge: number | null;
    note?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parseBrewDate(value?: string | null): Date | null {
    if (!value) return null;
    const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!match) return null;

    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
    date.setHours(0, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
}

function measurementDateTime(measurement: Measurement): Date | null {
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

    const row = measurement as Measurement & { date?: unknown; time?: unknown };
    const dateMatch = String(row.date ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!dateMatch) return null;

    let year = Number(dateMatch[3]);
    if (year < 100) year += 2000;
    const timeMatch = String(row.time ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
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

function eventDescriptor(notes: string): Pick<TimelineEvent, "type" | "label" | "icon"> | null {
    const text = notes.trim();
    if (!text) return null;

    if (/דרייהופ|דריי\s*הופ|הכנסת\s*כשות|כשות/i.test(text)) {
        return { type: "dryhop", label: "דרייהופ", icon: "🌿" };
    }
    if (/שמרים|הורדת\s*שמר|הוצאת\s*שמר/i.test(text)) {
        return { type: "yeast", label: "הורדת שמרים", icon: "🪣" };
    }
    if (/דיאציטיל|מנוחת|חימום/i.test(text)) {
        return { type: "diacetyl", label: "מנוחת דיאציטיל", icon: "🔥" };
    }
    if (/קירור|קורר|קירר/i.test(text)) {
        return { type: "cooling", label: "קירור", icon: "❄️" };
    }
    if (/סגירת\s*(?:מיכל|לחץ)?|סגירה|העלאת\s*לחץ|הורדת\s*לחץ/i.test(text)) {
        return { type: "pressure", label: "פעולת לחץ", icon: "🔒" };
    }
    if (/אריז|בקבוק|בקבוקים|חביות|חבית/i.test(text)) {
        return { type: "packaging", label: "אריזה", icon: "📦" };
    }

    return null;
}

function buildTimeline(measurements: Measurement[], brewDateValue?: string | null): TimelineEvent[] {
    const brewDate = parseBrewDate(brewDateValue);
    const events: TimelineEvent[] = [];

    if (brewDate) {
        events.push({
            id: "brew-start",
            type: "brew",
            label: "בישול",
            icon: "🍺",
            date: brewDate,
            dateLabel: formatDate(brewDate),
            brewAge: 0,
        });
    }

    let firstCarbonationAdded = false;

    [...measurements]
        .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))
        .forEach((measurement, index) => {
            const date = measurementDateTime(measurement);
            if (!date) return;

            const note = String(measurement.notes ?? "").trim();
            const descriptor = eventDescriptor(note);
            if (descriptor) {
                events.push({
                    id: `${descriptor.type}-${String(measurement.id ?? index)}`,
                    ...descriptor,
                    date,
                    dateLabel: formatDate(date),
                    timeLabel: formatTime(date),
                    brewAge: brewAgeAt(date, brewDate),
                    note,
                });
            }

            const carbonation = Number(
                (measurement as Measurement & { carbonation?: unknown }).carbonation
            );
            if (!firstCarbonationAdded && Number.isFinite(carbonation) && carbonation > 0) {
                firstCarbonationAdded = true;
                events.push({
                    id: `carbonation-${String(measurement.id ?? index)}`,
                    type: "carbonation",
                    label: "בדיקת גיזוז ראשונה",
                    icon: "🫧",
                    date,
                    dateLabel: formatDate(date),
                    timeLabel: formatTime(date),
                    brewAge: brewAgeAt(date, brewDate),
                    note: `גיזוז ${carbonation}`,
                });
            }
        });

    const unique = new Map<string, TimelineEvent>();
    events
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .forEach((event) => {
            // Several measurements on the same day may repeat the same action note.
            // Keep the first occurrence so the lifecycle stays readable.
            const dayKey = event.date.toISOString().slice(0, 10);
            const key = event.type === "yeast"
                ? event.id
                : `${event.type}-${dayKey}`;
            if (!unique.has(key)) unique.set(key, event);
        });

    return [...unique.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

export default function BatchTimeline({ measurements, brewDate }: Props) {
    const events = useMemo(
        () => buildTimeline(measurements, brewDate),
        [measurements, brewDate]
    );

    if (events.length === 0) return null;

    return (
        <section className="batch-timeline" dir="rtl" aria-label="ציר זמן של האצווה">
            <div className="batch-timeline-heading">
                <strong>ציר זמן</strong>
                <span>{events.length} אירועים מרכזיים באצווה</span>
            </div>

            <div className="batch-timeline-scroll">
                <div className="batch-timeline-track">
                    {events.map((event) => (
                        <article
                            key={event.id}
                            className={`batch-timeline-event batch-timeline-${event.type}`}
                            title={event.note || event.label}
                        >
                            <div className="batch-timeline-marker" aria-hidden="true">
                                {event.icon}
                            </div>
                            <div className="batch-timeline-label">{event.label}</div>
                            <div className="batch-timeline-meta">
                                {event.brewAge !== null && <strong>יום {event.brewAge}</strong>}
                                <span>{event.dateLabel}</span>
                                {event.timeLabel && event.timeLabel !== "00:00" && (
                                    <span>{event.timeLabel}</span>
                                )}
                            </div>
                        </article>
                    ))}
                </div>
            </div>
        </section>
    );
}
