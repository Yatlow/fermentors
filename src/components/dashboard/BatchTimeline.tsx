import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import {
    parseYeastDropAmount,
    type Measurement,
} from "../../SERVICES/cellering/calculateCelleringRecomendations";
import { expandCompoundCellarMeasurements } from "../../SERVICES/cellering/bottomCarbonation";
import {
    buildBatchTimeline,
    type TimelineEvent,
} from "../../SERVICES/dashboard/batchTimelineModel";
import "./BatchTimeline.css";

type Props = {
    measurements: Measurement[];
    brewDate?: string | null;
};

function TimelineIcon({ event }: { event: TimelineEvent }) {
    if (event.type === "pressure") {
        return <Gauge size={22} strokeWidth={2.2} aria-hidden="true" />;
    }
    return <>{event.icon}</>;
}

function bottomCarbonationEvent(event: TimelineEvent): TimelineEvent {
    const note = String(event.note ?? "");
    const hasStart = note.includes("תחילת גיזוז מלמטה");
    const hasClose = note.includes("סגירת גיזוז מלמטה");

    if (hasStart && hasClose) {
        const startTime = note.match(/תחילת גיזוז מלמטה\s+בשעה\s*(\d{1,2}:\d{2})/i)?.[1];
        const closeMatch = note.match(/סגירת גיזוז מלמטה\s+בשעה\s*(\d{1,2}:\d{2})(?:\s+על\s*(\d+(?:[.,]\d+)?)\s*bar)?/i);
        const finalPressureMatch = [...note.matchAll(/(העלאת|הורדת|שינוי)\s+לחץ\s+ל\s*:?-?\s*(\d+(?:[.,]\d+)?)/gi)].at(-1);
        const finalPressureAction = finalPressureMatch?.[1];
        const finalPressure = finalPressureMatch?.[2];
        return {
            ...event,
            type: "carbonation",
            label: "גיזוז מלמטה",
            icon: "🫧",
            detail: [
                startTime ? `התחלה ${startTime}` : "",
                closeMatch?.[1] ? `סיום ${closeMatch[1]}` : "",
                closeMatch?.[2] ? `לחץ בסיום ${closeMatch[2].replace(",", ".")} bar` : "",
                finalPressure
                    ? `${finalPressureAction === "הורדת" ? "הורדת" : finalPressureAction === "שינוי" ? "שינוי" : "העלאת"} לחץ ל${finalPressure.replace(",", ".")} bar`
                    : "",
            ].filter(Boolean).join(" · ") || undefined,
        };
    }

    if (hasStart) {
        const pressure = note.match(/הורדת לחץ ל\s*:?-?\s*(\d+(?:[.,]\d+)?)\s*bar/i)?.[1];
        const time = note.match(/בשעה\s*(\d{1,2}:\d{2})/)?.[1];
        return {
            ...event,
            type: "carbonation",
            label: "תחילת גיזוז מלמטה",
            icon: "🫧",
            detail: [pressure ? `לחץ ${pressure.replace(",", ".")} bar` : "", time ? `התחלה ${time}` : ""]
                .filter(Boolean)
                .join(" · ") || undefined,
        };
    }
    if (hasClose) {
        const pressure = note.match(/על\s*(\d+(?:[.,]\d+)?)\s*bar/i)?.[1];
        const time = note.match(/בשעה\s*(\d{1,2}:\d{2})/)?.[1];
        return {
            ...event,
            type: "carbonation",
            label: "סגירת גיזוז מלמטה",
            icon: "🫧",
            detail: [pressure ? `לחץ ${pressure.replace(",", ".")} bar` : "", time ? `סגירה ${time}` : ""]
                .filter(Boolean)
                .join(" · ") || undefined,
        };
    }
    return event;
}

export default function BatchTimeline({ measurements, brewDate }: Props) {
    const events = useMemo(() => {
        const expanded = expandCompoundCellarMeasurements(measurements);
        return buildBatchTimeline(expanded, brewDate, parseYeastDropAmount)
            .map(bottomCarbonationEvent);
    }, [measurements, brewDate]);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const startSentinelRef = useRef<HTMLSpanElement | null>(null);
    const endSentinelRef = useRef<HTMLSpanElement | null>(null);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const [canScrollLeft, setCanScrollLeft] = useState(false);

    useEffect(() => {
        const root = scrollRef.current;
        const start = startSentinelRef.current;
        const end = endSentinelRef.current;
        if (!root || !start || !end) return;

        const updateFallback = () => {
            if (root.scrollWidth <= root.clientWidth + 2) {
                setCanScrollRight(false);
                setCanScrollLeft(false);
            }
        };

        if (typeof IntersectionObserver === "undefined") {
            setCanScrollLeft(root.scrollWidth > root.clientWidth + 2);
            setCanScrollRight(false);
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.target === start) setCanScrollRight(!entry.isIntersecting);
                    if (entry.target === end) setCanScrollLeft(!entry.isIntersecting);
                });
                updateFallback();
            },
            { root, threshold: 0.95 }
        );

        observer.observe(start);
        observer.observe(end);
        updateFallback();

        const resizeObserver = typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(updateFallback)
            : null;
        resizeObserver?.observe(root);

        return () => {
            observer.disconnect();
            resizeObserver?.disconnect();
        };
    }, [events.length]);

    if (events.length === 0) return null;

    return (
        <section className="batch-timeline" dir="rtl" aria-label="ציר זמן של האצווה">
            <div className="batch-timeline-heading">
                <strong>ציר זמן</strong>
                <span>{events.length} אירועים באצווה</span>
            </div>

            <div className="batch-timeline-scroll-shell">
                <div className="batch-timeline-scroll" ref={scrollRef}>
                    <div className="batch-timeline-track">
                        <span ref={startSentinelRef} className="batch-timeline-sentinel" aria-hidden="true" />

                        {events.map((event) => (
                            <article
                                key={event.id}
                                className={`batch-timeline-event batch-timeline-${event.type}`}
                                title={event.note || event.detail || event.label}
                            >
                                <div className="batch-timeline-marker" aria-hidden="true">
                                    <TimelineIcon event={event} />
                                </div>
                                <div className="batch-timeline-label">{event.label}</div>
                                {event.detail && (
                                    <div className="batch-timeline-detail">{event.detail}</div>
                                )}
                                <div className="batch-timeline-meta">
                                    {event.brewAge !== null && <strong>יום {event.brewAge}</strong>}
                                    <span>{event.dateLabel}</span>
                                    {event.timeLabel && event.timeLabel !== "00:00" && (
                                        <span>{event.timeLabel}</span>
                                    )}
                                </div>
                            </article>
                        ))}

                        <span ref={endSentinelRef} className="batch-timeline-sentinel" aria-hidden="true" />
                    </div>
                </div>

                <div
                    className={`batch-timeline-scroll-hint batch-timeline-scroll-hint-right ${canScrollRight ? "visible" : ""}`}
                    aria-hidden="true"
                >
                    <span>‹</span>
                </div>
                <div
                    className={`batch-timeline-scroll-hint batch-timeline-scroll-hint-left ${canScrollLeft ? "visible" : ""}`}
                    aria-hidden="true"
                >
                    <span>›</span>
                </div>
            </div>
        </section>
    );
}
