import { batchDryHopThreshold } from "./dryHopThreshold";
import { isCompletedYeastDrop } from "./coolingYeastTiming";
import { hasActualCooling } from "./neglectAfterCooling";
import type { ConditionalForecast, ForecastTank } from "./coldCellarForecast";

type Reading = { id?: string | number | null; notes?: string | number | null };
type CoolingForecastTank = ForecastTank & { batchNumber?: string | number | null };
const dateOf = (id: unknown): string | null =>
    String(id ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:_|$)/)?.[1] ?? null;
const dayNumber = (date: string) => Date.parse(date + "T12:00:00Z") / 86400000;
const addDays = (date: string, count: number) =>
    new Date((dayNumber(date) + count) * 86400000).toISOString().slice(0, 10);
const nextWorkday = (date: string) =>
    new Date(date + "T12:00:00Z").getUTCDay() === 6 ? addDays(date, 1) : date;

/**
 * Pure, read-free validation of the forecast timeline. A statistical threshold
 * check is not a completed dry-hop or yeast removal. Nevertheless, it can
 * conditionally project when the next operation could first take place.
 *
 * The cooling estimator itself retains its style curve, measured calibration,
 * actual Plato-stability guard, style limit and batch-specific warm test.
 * This function enforces sequencing ON TOP of that date:
 * dry-hop -> five calendar days -> warm yeast drop -> next-day cooling.
 */
export function validateForecastDependencies(
    tank: CoolingForecastTank,
    readings: Reading[],
    today: string,
    forecasts: ConditionalForecast[],
    nonHoppyYeast: readonly ConditionalForecast[] = [],
): ConditionalForecast[] {
    if (tank.stage?.name !== "בתסיסה") return forecasts;
    const actualRows = readings.filter(row => {
        const date = dateOf(row.id);
        return date !== null && date <= today;
    });
    if (actualRows.some(row => hasActualCooling(String(row.notes ?? "")))) return forecasts.filter(
        row => !/:cooling-(?:readiness|conditions):/.test(row.id)
    );
    const actualDryHop = actualRows.filter(row => String(row.notes ?? "").includes("כשות"))
        .map(row => dateOf(row.id)!).sort().at(0) ?? null;
    const actualDrops = actualRows.filter(row => isCompletedYeastDrop(row.notes))
        .map(row => dateOf(row.id)!).sort();
    const isHoppy = batchDryHopThreshold(tank.beerStyle, undefined, tank) !== null;
    const predictedDryHop = !actualDryHop && isHoppy
        ? forecasts.find(row => row.id.includes(":plato-recheck:") && /דרייהופ/.test(row.title))?.dueDate ?? null
        : null;
    const actualDrop = actualDrops.filter(date => !isHoppy || !actualDryHop || date >= actualDryHop).at(-1) ?? null;
    const upcomingYeast = !actualDrop && isHoppy
        ? (actualDryHop ?? predictedDryHop)
            ? nextWorkday(addDays((actualDryHop ?? predictedDryHop)!, 5)) : null
        : !actualDrop
            ? nonHoppyYeast.filter(row => row.dueDate >= today)
                .map(row => nextWorkday(row.dueDate)).sort().at(0) ?? null
            : null;

    const dependentYeast: ConditionalForecast[] = predictedDryHop && upcomingYeast && !actualDrop
        ? [{
            id: tank.id + ":warm-yeast-after-projected-dry-hop:" + upcomingYeast,
            tankNumber: String(tank.tankNumber ?? tank.id),
            dueDate: upcomingYeast,
            title: "צפי להורדת שמרים אחרי דרייהופ",
            basis: "חמישה ימים לאחר הדרייהופ הצפוי, אם יבוצע במועד",
        }]
        : [];

    // No evidence or projected date for a necessary warm yeast drop means no
    // justified cooling-readiness date, even when the style curve is flat.
    const yeastDate = actualDrop ?? upcomingYeast;
    const earliestCooling = yeastDate ? addDays(yeastDate, 1) : null;
    const validated = forecasts.flatMap(row => {
        if (!/:cooling-(?:readiness|conditions):/.test(row.id)) return [row];
        if (!earliestCooling) return [];
        const dueDate = nextWorkday(row.dueDate < earliestCooling ? earliestCooling : row.dueDate);
        return [{
            ...row,
            id: row.id.replace(/:cooling-(?:readiness|conditions):\d{4}-\d{2}-\d{2}$/,
                ":cooling-readiness:" + dueDate),
            dueDate,
            title: "צפי לבדיקת מוכנות לקירור",
            basis: row.basis + (actualDrop ? "" : "; מותנה בהורדת השמרים הצפויה"),
        }];
    });
    return [...validated, ...dependentYeast];
}
