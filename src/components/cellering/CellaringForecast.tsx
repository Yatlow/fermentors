import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { getMeasurementsByBatch, MEASUREMENTS_UPDATED_EVENT } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import { projectColdCellarMilestones, type ConditionalForecast } from "../../SERVICES/cellering/coldCellarForecast";
import { projectPlatoThresholdRecheck } from "../../SERVICES/cellering/platoThresholdForecast";
import {
    subscribeScheduledCellarRecommendations, scheduledActionLabel,
    type ScheduledCellarRecommendation,
} from "../../SERVICES/cellering/scheduledCellarRecommendations";
import { localDateKey } from "../../SERVICES/dashboard/healthModel";
import "../dashboard/HealthDashboard.css";

export default function CellaringForecast({ brews, specs }: { brews: Fermentor[]; specs: SpecChart | null }) {
    const [scheduled, setScheduled] = useState<ScheduledCellarRecommendation[]>([]);
    const [conditional, setConditional] = useState<ConditionalForecast[]>([]);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (!expanded) return;
        return subscribeScheduledCellarRecommendations(setScheduled,
            (error) => console.error("Failed to load cellar forecast schedule", error));
    }, [expanded]);
    useEffect(() => {
        const refreshData = () => setRefresh((previous) => previous + 1);
        window.addEventListener(MEASUREMENTS_UPDATED_EVENT, refreshData);
        return () => window.removeEventListener(MEASUREMENTS_UPDATED_EVENT, refreshData);
    }, []);
    const active = useMemo(() => brews.filter((tank) =>
        Number(tank.tankNumber) !== 1 && Number(tank.action) === 1
    ), [brews]);

    useEffect(() => {
        let cancelled = false;
        if (!specs || !expanded) return;
        const today = localDateKey(new Date());
        setLoading(true);
        void Promise.all(active.map(async (tank) => {
            try {
                const readings = tank.batchNumber ? await getMeasurementsByBatch(tank.batchNumber) : [];
                return [
                    ...projectColdCellarMilestones(tank, readings, today),
                    ...projectPlatoThresholdRecheck(tank, readings, today, specs),
                ];
            } catch (error) {
                console.error("Failed to calculate cellar forecast for tank", tank.tankNumber, error);
                return [] as ConditionalForecast[];
            }
        })).then((results) => {
            if (!cancelled) setConditional(results.flat());
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [active, specs, refresh, expanded]);

    const days = useMemo(() => {
        const today = localDateKey(new Date());
        const addDays = (date: string, n: number) => {
            const next = new Date(date + "T12:00:00Z");
            next.setUTCDate(next.getUTCDate() + n);
            return next.toISOString().slice(0, 10);
        };
        const dayOfWeek = (date: string) => new Date(date + "T12:00:00Z").getUTCDay();
        const nextWorkday = (date: string) => dayOfWeek(date) === 6 ? addDays(date, 1) : date;
        const coldTanks = active.filter((tank) => tank.stage?.name === "קר");
        return Array.from({ length: 7 }, (_, offset) => {
            const date = addDays(today, offset);
            if (dayOfWeek(date) === 6) return { date, scheduledRows: [] as ScheduledCellarRecommendation[], conditionalRows: [] as ConditionalForecast[], routines: [] as string[], total: 0 };
            const scheduledRows = scheduled.filter((item) => {
                const due = nextWorkday(item.dueDate);
                return (due === date || (offset === 0 && due < date)) &&
                    active.some((tank) => String(tank.tankNumber) === item.tankNumber &&
                        String(tank.batchNumber) === item.batchNumber);
            });
            const conditionalRows = conditional.filter((item) =>
                nextWorkday(item.dueDate) === date &&
                !scheduledRows.some((row) => row.tankNumber === item.tankNumber &&
                    (item.title.includes("גיזוז") ? row.actionType === "carbTest" :
                        item.title.includes("שמרים") ? row.actionType === "yeastDrop" : false))
            );
            const numbers = coldTanks.map((tank) => String(tank.tankNumber)).sort((a,b) => Number(a) - Number(b));
            // Weekly checks are suggestions for the named cold tanks, not recorded
            // scheduled recommendations. Sunday is deliberately not repeated here.
            const weekday = dayOfWeek(date);
            const routines = numbers.length === 0 ? [] :
                weekday === 3 ? [`בדיקות גיזוז לקראת השבוע הבא · מיכלים ${numbers.join(", ")}`] :
                weekday === 4 ? [`בדיקת צורך בהורדת שמרים לקראת השבוע הבא · מיכלים ${numbers.join(", ")}`] : [];
            return { date, scheduledRows, conditionalRows, routines, total: scheduledRows.length + conditionalRows.length + routines.length };
        });
    }, [active, scheduled, conditional]);

    const total = days.reduce((sum, day) => sum + day.total, 0);
    return <section className="health-daily-actions" dir="rtl" aria-label="תחזית סלרינג לשבעה ימים">
        <button type="button" className="health-restore-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            תחזית סלרינג · 7 ימים {loading ? "· מחשב…" : total ? `· ${total} פריטים` : ""} {expanded ? "▴" : "▾"}
        </button>
        {expanded && <div className="health-daily-actions-list">
            {days.filter((day) => day.total > 0).map((day) => <div className="health-daily-action" key={day.date}>
                <strong>{day.date}</strong>
                {day.scheduledRows.map((item) => <span key={item.id}>
                    מיכל {item.tankNumber} · {scheduledActionLabel(item.actionType)} · {(new Date(item.dueDate + "T12:00:00Z").getUTCDay() === 6 ? new Date(Date.parse(item.dueDate + "T12:00:00Z") + 86400000).toISOString().slice(0, 10) : item.dueDate) < day.date ? `באיחור מאז ${item.dueDate}` : "נקבע מראש"}
                </span>)}
                {day.conditionalRows.map((item) => <span key={item.id}>
                    מיכל {item.tankNumber} · {item.title}{item.title.includes("תנאים ל") ? " — צפוי להתקרב לסף לפי קצב הפלאטו האחרון" : ""}
                </span>)}
                {day.routines.map((item) => <span key={item}>{item}</span>)}
            </div>)}
            {!total && !loading && <p>לא נמצאו פעולות מתוזמנות, אבני דרך או שגרות צפויות במהלך שבעת הימים הקרובים.</p>}
            <small>תחזית בלבד — פעולות מותנות טעונות אימות ביום הביצוע.</small>
        </div>}
    </section>;
}
