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

export default function CellaringForecast({ brews, specs }: { brews: Fermentor[]; specs: SpecChart | null }) {
    const [scheduled, setScheduled] = useState<ScheduledCellarRecommendation[]>([]);
    const [conditional, setConditional] = useState<ConditionalForecast[]>([]);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(true);

    useEffect(() => subscribeScheduledCellarRecommendations(setScheduled,
        (error) => console.error("Failed to load cellar forecast schedule", error)), []);
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
        if (!specs) return;
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
    }, [active, specs, refresh]);

    const days = useMemo(() => Array.from({ length: 7 }, (_, offset) => {
        const day = new Date();
        day.setDate(day.getDate() + offset);
        const date = localDateKey(day);
        const scheduledRows = scheduled.filter((item) =>
            (item.dueDate === date || (offset === 0 && item.dueDate < date)) &&
            active.some((tank) => String(tank.tankNumber) === item.tankNumber &&
                String(tank.batchNumber) === item.batchNumber)
        );
        const conditionalRows = conditional.filter((item) => item.dueDate === date &&
            !scheduledRows.some((row) => row.tankNumber === item.tankNumber &&
                (item.title.includes("גיזוז") ? row.actionType === "carbTest" :
                    item.title.includes("שמרים") ? row.actionType === "yeastDrop" : false)));
        const weekday = day.getDay();
        const coldCount = active.filter((tank) => tank.stage?.name === "קר").length;
        const routines = coldCount === 0 ? [] :
            weekday === 0 ? ["שגרת יום ראשון: בדיקת גיזוז והורדת שמרים למיכלים קרים"] :
            weekday === 3 ? ["שגרת יום רביעי: בדיקות גיזוז לקראת השבוע הבא"] :
            weekday === 4 ? ["שגרת יום חמישי: הורדת שמרים לקראת השבוע הבא"] : [];
        return { date, scheduledRows, conditionalRows, routines, total: scheduledRows.length + conditionalRows.length + routines.length };
    }), [active, scheduled, conditional]);

    const total = days.reduce((sum, day) => sum + day.total, 0);
    return <section className="health-daily-actions" dir="rtl" aria-label="תחזית סלרינג לשבעה ימים">
        <button type="button" className="health-restore-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            תחזית סלרינג · 7 ימים {loading ? "· מחשב…" : total ? `· ${total} פריטים` : ""} {expanded ? "▴" : "▾"}
        </button>
        {expanded && <div className="health-daily-actions-list">
            {days.filter((day) => day.total > 0).map((day) => <div className="health-daily-action" key={day.date}>
                <strong>{day.date}</strong>
                {day.scheduledRows.map((item) => <span key={item.id}>
                    מיכל {item.tankNumber} · {scheduledActionLabel(item.actionType)} · {item.dueDate < day.date ? `באיחור מאז ${item.dueDate}` : "נקבע מראש"}
                </span>)}
                {day.conditionalRows.map((item) => <span key={item.id}>
                    מיכל {item.tankNumber} · {item.title} · מותנה: {item.basis}
                </span>)}
                {day.routines.map((item) => <span key={item}>שגרה לבדיקה · {item}. יש לבדוק צורך ומוכנות למיכל ביום הביצוע.</span>)}
            </div>)}
            {!total && !loading && <p>לא נמצאו פעולות מתוזמנות, אבני דרך או שגרות צפויות במהלך שבעת הימים הקרובים.</p>}
            <small>פעולות שנקבעו מראש מובחנות מהערכות לפי מדידות ומשגרת השבוע. התחזית אינה פקודת ביצוע; לפני פעולה בודקים את המלצת המנוע העדכנית, סטטוס המיכל ואריזה מתוכננת.</small>
        </div>}
    </section>;
}
