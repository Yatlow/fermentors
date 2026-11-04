import type { ConditionalForecast } from "./coldCellarForecast";

export type ForecastRoutine = {
    id: string;
    tankNumber: string;
    actionType: "carbTest" | "yeastDrop";
    title: string;
    source: "sunday" | "sunday-predicted-cold" | "packaging";
};

type ScheduledAction = { tankNumber: string; actionType: string };

type ForecastTankSnapshot = {
    tankNumber?: string | number | null;
    batchNumber?: string | number | null;
    stage?: { name?: string } | null;
};
type ScheduledCooling = ScheduledAction & { batchNumber: string | number; dueDate: string };

const batchKey = (value: unknown) => String(value ?? "").replace(/^#/, "").trim();

/**
 * A tank still fermenting today is only a CONDITIONAL Sunday cold-tank candidate.
 * Require an actual future cooling decision or a fresh cooling-readiness forecast
 * dated BEFORE Sunday. A readiness check is not proof that cooling happened.
 */
export function anticipatedColdTanksForSunday(input: {
    today: string;
    sunday: string;
    tanks: ForecastTankSnapshot[];
    scheduled: ScheduledCooling[];
    conditional: ConditionalForecast[];
}): string[] {
    const { today, sunday, tanks, scheduled, conditional } = input;
    return tanks.flatMap((tank) => {
        if (tank.stage?.name !== "בתסיסה" || tank.tankNumber == null || !tank.batchNumber) return [];
        const tankNumber = String(tank.tankNumber);
        const plannedCooling = scheduled.some((item) =>
            item.tankNumber === tankNumber &&
            batchKey(item.batchNumber) === batchKey(tank.batchNumber) &&
            item.actionType === "coolDown" &&
            item.dueDate >= today && item.dueDate < sunday
        );
        const projectedReadiness = conditional.some((item) =>
            item.tankNumber === tankNumber &&
            item.id.includes(":cooling-readiness:") &&
            item.dueDate >= today && item.dueDate < sunday
        );
        return plannedCooling || projectedReadiness ? [tankNumber] : [];
    });
}


/** Calendar routines are one action per tank, not one action per list of tanks.
 * Explicit and rule-based actions for the same tank/day take precedence.
 */
export function forecastRoutinesForDate(input: {
    date: string;
    weekday: number;
    coldTankNumbers: string[];
    anticipatedColdTankNumbers?: string[];
    nextWeekPackagingTankNumbers: string[];
    scheduled: ScheduledAction[];
    conditional: ConditionalForecast[];
}): ForecastRoutine[] {
    const { date, weekday, scheduled, conditional } = input;
    const cold = new Set(input.coldTankNumbers);
    const anticipatedCold = new Set(input.anticipatedColdTankNumbers ?? []);
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
        for (const tank of anticipatedCold) {
            if (cold.has(tank)) continue;
            add(tank, "carbTest", "sunday-predicted-cold");
            add(tank, "yeastDrop", "sunday-predicted-cold");
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
