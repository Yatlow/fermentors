import type { ConditionalForecast } from "./coldCellarForecast";

export type ForecastRoutine = {
    id: string;
    tankNumber: string;
    actionType: "carbTest" | "yeastDrop";
    title: string;
    source: "sunday" | "packaging";
};

type ScheduledAction = { tankNumber: string; actionType: string };

/** Calendar routines are one action per tank, not one action per list of tanks.
 * Explicit and rule-based actions for the same tank/day take precedence.
 */
export function forecastRoutinesForDate(input: {
    date: string;
    weekday: number;
    coldTankNumbers: string[];
    nextWeekPackagingTankNumbers: string[];
    scheduled: ScheduledAction[];
    conditional: ConditionalForecast[];
}): ForecastRoutine[] {
    const { date, weekday, scheduled, conditional } = input;
    const cold = new Set(input.coldTankNumbers);
    const candidates: ForecastRoutine[] = [];
    const add = (tankNumber: string, actionType: ForecastRoutine["actionType"], source: ForecastRoutine["source"]) => {
        candidates.push({
            id: date + ":" + tankNumber + ":" + actionType,
            tankNumber,
            actionType,
            source,
            title: actionType === "carbTest" ? "בדיקת גיזוז" : "הורדת שמרים",
        });
    };

    if (weekday === 0) {
        for (const tank of cold) {
            add(tank, "carbTest", "sunday");
            add(tank, "yeastDrop", "sunday");
        }
    } else if (weekday === 3) {
        for (const tank of new Set(input.nextWeekPackagingTankNumbers)) {
            if (cold.has(tank)) add(tank, "carbTest", "packaging");
        }
    } else if (weekday === 4) {
        for (const tank of new Set(input.nextWeekPackagingTankNumbers)) {
            add(tank, "yeastDrop", "packaging");
        }
    }

    const hasConditionalAction = (row: ConditionalForecast, type: ForecastRoutine["actionType"]) =>
        type === "carbTest" ? /בדיקת גיזוז/.test(row.title) : /הורדת שמרים/.test(row.title);
    return candidates.filter((row) =>
        !scheduled.some((item) => item.tankNumber === row.tankNumber && item.actionType === row.actionType) &&
        !conditional.some((item) => item.tankNumber === row.tankNumber && hasConditionalAction(item, row.actionType))
    );
}
