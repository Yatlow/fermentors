import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { db } from "../../firebase";
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
import "./CellaringForecast.css";

export default function CellaringForecast({ brews, specs }: { brews: Fermentor[]; specs: SpecChart | null }) {
    const [scheduled, setScheduled] = useState<ScheduledCellarRecommendation[]>([]);
    const [conditional, setConditional] = useState<ConditionalForecast[]>([]);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [nextWeekTanks, setNextWeekTanks] = useState<Record<string, string[]>>({});

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

    // Wednesday/Thursday recommendations apply ONLY to tanks with a committed
    // packaging decision in the following week. Fetch the specific week on
    // expansion rather than subscribing to all planning history.
    useEffect(() => {
        if (!expanded) return;
        let cancelled = false;
        const localToday = localDateKey(new Date());
        const utcDay = (date: string) => new Date(date + "T12:00:00Z").getUTCDay();
        const plusDays = (date: string, count: number) => {
            const day = new Date(date + "T12:00:00Z");
            day.setUTCDate(day.getUTCDate() + count);
            return day.toISOString().slice(0, 10);
        };
        const weekStart = (date: string) => plusDays(date, -utcDay(date));
        const nextWeeks = [...new Set(Array.from({ length: 8 }, (_, offset) => {
            const date = plusDays(localToday, offset);
            return utcDay(date) === 3 || utcDay(date) === 4 ? plusDays(weekStart(date), 7) : null;
        }).filter((date): date is string => Boolean(date)))];
        if (!nextWeeks.length) return;
        // One read per target week, at most two within this horizon.
        void Promise.all(nextWeeks.map(async (week) => {
            const snapshot = await getDocs(query(collection(db, "planningWeeks"), where("id", "==", week), limit(1)));
            const plan = snapshot.docs[0]?.data();
            const numbers = (Array.isArray(plan?.packaging) ? plan.packaging : []).flatMap((run: {
                tankNumber?: string | number; tankId?: string | number; quantity?: number;
            }) => {
                if (!(Number(run.quantity) > 0)) return [];
                const match = active.find((tank) =>
                    String(tank.tankNumber) === String(run.tankNumber ?? "") ||
                    String(tank.id) === String(run.tankId ?? ""));
                return match ? [String(match.tankNumber)] : [];
            });
            return [week, [...new Set(numbers)].sort((a, b) => Number(a) - Number(b))] as const;
        })).then((rows) => {
            if (!cancelled) setNextWeekTanks(Object.fromEntries(rows));
        }).catch((error) => {
            console.error("Failed to load planned cellar work for packaging weeks", error);
            if (!cancelled) setNextWeekTanks({});
        });
        return () => { cancelled = true; };
    }, [expanded, active]);

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
        // If the last calendar day is Saturday, include Sunday as the replacement workday.
        const horizon = dayOfWeek(addDays(today, 6)) === 6 ? 8 : 7;
        return Array.from({ length: horizon }, (_, offset) => {
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
            const weekday = dayOfWeek(date);
            const nextWeek = addDays(date, 7 - weekday);
            const plannedNumbers = nextWeekTanks[nextWeek] ?? [];
            const routines = plannedNumbers.length === 0 ? [] :
                weekday === 3 ? [`בדיקת גיזוז לפני אריזת השבוע הבא · מיכלים ${plannedNumbers.filter((number) => coldTanks.some((tank) => String(tank.tankNumber) === number)).join(", ")}`] :
                weekday === 4 ? [`הורדת שמרים לפני אריזת השבוע הבא · מיכלים ${plannedNumbers.join(", ")}`] : [];
            // Wednesday needs cold tanks; Thursday follows the committed
            // packaging decision even if a tank is not marked cold.
            const validRoutines = routines.filter((item) => !item.endsWith("מיכלים "));
            return { date, scheduledRows, conditionalRows, routines: validRoutines, total: scheduledRows.length + conditionalRows.length + validRoutines.length };
        });
    }, [active, scheduled, conditional, nextWeekTanks]);

    const total = days.reduce((sum, day) => sum + day.total, 0);
    const dateLabel = (date: string) => {
        const day = new Date(date + "T12:00:00Z");
        return new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "numeric", timeZone: "UTC" }).format(day);
    };
    return <section className="cellar-forecast" dir="rtl" aria-label="תחזית סלרינג לשבעה ימים">
        <button type="button" className="cellar-forecast-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            <span className="cellar-forecast-toggle-title">תחזית סלרינג <small>7 ימים קדימה</small></span>
            <span className="cellar-forecast-toggle-info">{expanded && loading ? "מחשב…" : expanded && total ? `${total} פעולות צפויות` : ""} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span></span>
        </button>
        {expanded && <div className="cellar-forecast-content">
            {days.filter((day) => day.total > 0).map((day) => <section className="cellar-forecast-day" key={day.date}>
                <header className="cellar-forecast-date"><strong>{dateLabel(day.date)}</strong><span>{day.total} {day.total === 1 ? "פעולה" : "פעולות"}</span></header>
                <div className="cellar-forecast-items">
                    {day.scheduledRows.map((item) => <div className="cellar-forecast-item" key={item.id}>
                        <span className="cellar-forecast-type">מתוזמן</span>
                        <div><strong>מיכל {item.tankNumber}</strong> · {scheduledActionLabel(item.actionType)}
                        {item.dueDate < day.date && new Date(item.dueDate + "T12:00:00Z").getUTCDay() !== 6 ? <small> · באיחור מאז {item.dueDate}</small> : null}</div>
                    </div>)}
                    {day.conditionalRows.map((item) => <div className="cellar-forecast-item" key={item.id}>
                        <span className="cellar-forecast-type cellar-forecast-conditional">צפי</span>
                        <div><strong>מיכל {item.tankNumber}</strong> · {item.title.includes("תנאים ל") ?
                            item.title.replace("בדיקת תנאים ל", "צפוי להתקרב לסף ") :
                            item.title}</div>
                    </div>)}
                    {day.routines.map((item) => <div className="cellar-forecast-item" key={item}>
                        <span className="cellar-forecast-type cellar-forecast-routine">לפי תכנון</span>
                        <div>{item}</div>
                    </div>)}
                </div>
            </section>)}
            {!total && !loading && <p className="cellar-forecast-empty">לא נמצאו פעולות צפויות לשבוע הקרוב.</p>}
        </div>}
    </section>;
}
