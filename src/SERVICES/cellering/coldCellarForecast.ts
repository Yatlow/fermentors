import type { Fermentor } from "../../App";
import type { Measurement } from "./calculateCelleringRecomendations";

export type ConditionalForecast = {
    id: string;
    tankNumber: string;
    dueDate: string;
    title: string;
    basis: string;
};

/** Pure projection from measurements already loaded for the health engine.
 * These are possible due dates assuming no new action is logged, not predictions
 * of future Plato, temperature, or carbonation.
 */
export function projectColdCellarMilestones(tank: Fermentor, measurements: Measurement[], today: string): ConditionalForecast[] {
    if (tank.stage?.name !== "קר") return [];
    const sorted = [...measurements].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
    const cooling = [...sorted].reverse().find((item) => /קירור/.test(String(item.notes ?? "")));
    const cooledOn = String(cooling?.id ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!cooledOn || cooledOn > today) return [];
    const postCooling = sorted.filter((item) => String(item.id ?? "").slice(0, 10) >= cooledOn);
    const hasCarb = postCooling.some((item) => item.carbonation !== null && item.carbonation !== undefined &&
        item.carbonation !== "" && Number.isFinite(Number(item.carbonation)));
    const yeastActions = postCooling.filter((item) =>
        String(item.id ?? "") > String(cooling?.id ?? "") && /שמרים|שמרי/.test(String(item.notes ?? "")));
    const result: ConditionalForecast[] = [];
    const add = (date: string, key: string, title: string, basis: string) => {
        // Do not silently move an overdue recommendation to a fabricated future date.
        if (date < today) return;
        result.push({ id: `${tank.id}:${key}:${date}`, tankNumber: String(tank.tankNumber ?? tank.uid ?? tank.id),
            dueDate: date, title, basis });
    };
    const addDays = (day: string, count: number) => {
        const date = new Date(`${day}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + count);
        return date.toISOString().slice(0, 10);
    };
    if (!hasCarb) add(addDays(cooledOn, 1), "first-carb", "בדיקת גיזוז ראשונה", "יום אחרי קירור, אם טרם תתבצע מדידה");
    if (!yeastActions.length) {
        add(addDays(cooledOn, 2), "first-yeast", "הורדת שמרים אחרי קירור", "יומיים אחרי קירור, בכפוף למדידות");
    } else if (yeastActions.length === 1) {
        const firstDate = String(yeastActions[0].id ?? "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(firstDate) &&
            new Date(`${firstDate}T12:00:00Z`).getUTCDay() === 0) {
            add(addDays(firstDate, 2), "second-yeast", "הורדת שמרים נוספת", "יומיים אחרי הורדת שמרים ביום ראשון");
        }
    }
    return result;
}

