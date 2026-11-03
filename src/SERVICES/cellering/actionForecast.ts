import { carbonationRetestPolicy, shouldRecommendCarbonationRetestOnDate, type CarbonationRetestMeasurement } from "./carbonationRetestPolicy";
import { batchDryHopThreshold } from "./dryHopThreshold";
import { carbonationSpecKey } from "./fermentationEndPlato";
import { hasActualCooling } from "./neglectAfterCooling";
import { isCompletedYeastDrop } from "./coolingYeastTiming";
import type { ForecastTank, ConditionalForecast } from "./coldCellarForecast";

type ForecastSpecs = { carbonation?: Record<string, number>; tolorances?: Record<string, number> };
type ForecastReading = CarbonationRetestMeasurement & { plato?: string | number | null };
type WarmYeastTank = ForecastTank & { brewDate?: string | null };

const dateKey = (id: unknown) => String(id ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:_|$)/)?.[1] ?? null;
const dayValue = (day: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!match) return null;
    const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return new Date(utc).toISOString().slice(0, 10) === day ? utc / 86400000 : null;
};
const plusDays = (day: string, amount: number) => {
    const stamp = dayValue(day);
    return stamp === null ? null : new Date((stamp + amount) * 86400000).toISOString().slice(0, 10);
};
const brewDateKey = (raw: unknown) => {
    const value = String(raw ?? "").trim();
    const iso = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
    const key = iso?.[1] ?? (local
        ? local[3] + "-" + local[2].padStart(2, "0") + "-" + local[1].padStart(2, "0")
        : null);
    return key && dayValue(key) !== null ? key : null;
};

/** Matches the live cellar carbonation target, tolerance and severity policy. */
function carbonationDeviation(value: number, style: unknown, specs: ForecastSpecs) {
    const defaults: Record<string, number> = {
        ipa: 2.45, "פייל": 2.4, "לאגר": 2.5, "הופי": 2.5,
        "חיטה": 2.5, "סטאוט": 2.2, other: 2.45,
    };
    const targets = specs.carbonation ?? defaults;
    const target = targets[carbonationSpecKey(String(style ?? ""))] ?? targets.other;
    if (!Number.isFinite(target)) return null;
    const tolerance = specs.tolorances?.carbonation ?? 0.04;
    const outOfSpec = value >= target + tolerance || value <= target - tolerance;
    const importance = value >= target + 0.1 || value <= target - 0.1 ? 3 : outOfSpec ? 2 : 1;
    return { outOfSpec, importance };
}

/**
 * Predict only the earliest NEXT repeat test justified by an already failed test.
 * Re-use the daily waiting policy on future dates; never assume a future test
 * will fail or that an operator will change pressure in the future.
 */
export function projectCarbonationRetest(
    tank: ForecastTank,
    readings: ForecastReading[],
    today: string,
    specs: ForecastSpecs,
): ConditionalForecast[] {
    if (tank.stage?.name !== "קר" || dayValue(today) === null) return [];
    const history = readings.filter((row) => {
        const date = dateKey(row.id);
        return date !== null && date <= today;
    });
    const current = carbonationRetestPolicy(history, today);
    if (!current.hasCarbonation || current.lastCarbonation === null) return [];
    const deviation = carbonationDeviation(current.lastCarbonation, tank.beerStyle, specs);
    if (!deviation?.outOfSpec) return [];

    // A currently actionable recommendation belongs to today's dashboard.
    // The only exception is an automatically deferred Friday/Saturday item.
    const weekdayToday = new Date(today + "T12:00:00Z").getUTCDay();
    if (current.due && weekdayToday !== 6 &&
        shouldRecommendCarbonationRetestOnDate(today, deviation.importance)) return [];

    for (let offset = 1; offset <= 8; offset++) {
        const candidate = plusDays(today, offset);
        if (!candidate) break;
        const weekday = new Date(candidate + "T12:00:00Z").getUTCDay();
        if (weekday === 6 || !shouldRecommendCarbonationRetestOnDate(candidate, deviation.importance)) continue;
        const policy = carbonationRetestPolicy(history, candidate);
        if (!policy.due) continue;
        const anchor = policy.treatmentDate ?? policy.lastCarbonationDate ?? "";
        const reason = policy.waitReason === "bottom_carbonation" ? "לאחר סיום גיזוז מלמטה"
            : policy.waitReason === "ordinary_pressure" ? "לאחר שינוי לחץ" : "לאחר בדיקה לא תקינה ללא טיפול מתועד";
        return [{
            id: tank.id + ":carb-retest:" + candidate,
            tankNumber: String(tank.tankNumber ?? tank.uid ?? tank.id),
            dueDate: candidate,
            title: "בדיקת גיזוז חוזרת",
            basis: reason + " מ־" + anchor + " (גיזוז " + current.lastCarbonation + "); בכפוף לכך שלא תבוצע בדיקה או התערבות נוספת",
        }];
    }
    return [];
}

/**
 * Non-hoppy warm-yeast timing cannot be known from fermentation age alone.
 * Project a CONDITIONS CHECK from actual tank closure, fresh Plato history and
 * the existing five-day minimum; never claim that tomorrow's Plato is measured.
 */
export function projectNonHoppyWarmYeast(
    tank: WarmYeastTank,
    readings: ForecastReading[],
    today: string,
    specs: ForecastSpecs,
): ConditionalForecast[] {
    if (tank.stage?.name !== "בתסיסה" || dayValue(today) === null ||
        batchDryHopThreshold(tank.beerStyle, specs.tolorances, tank) !== null) return [];
    const brewedOn = brewDateKey(tank.brewDate);
    if (!brewedOn || brewedOn > today) return [];
    const history = readings.filter((row) => {
        const date = dateKey(row.id);
        return date !== null && date <= today;
    }).sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
    if (history.some((row) => isCompletedYeastDrop(row.notes) || hasActualCooling(String(row.notes ?? "")))) return [];
    const hasClosedTank = history.some((row) =>
        /סגיר(?:ת|ה).*(?:נשם|לחץ|פורק)/.test(String(row.notes ?? "")));
    if (!hasClosedTank) return [];

    const perDate = new Map<string, number>();
    for (const row of history) {
        const date = dateKey(row.id);
        if (!date || row.plato === null || row.plato === undefined || row.plato === "") continue;
        const value = Number(row.plato);
        if (Number.isFinite(value) && value > 0 && value <= 30) perDate.set(date, value);
    }
    const samples = [...perDate].slice(-2);
    if (samples.length !== 2) return [];
    const [[firstDate, first], [lastDate, last]] = samples;
    const separation = dayValue(lastDate)! - dayValue(firstDate)!;
    if (separation < 1 || separation > 3 || dayValue(today)! - dayValue(lastDate)! > 2) return [];
    const style = String(tank.beerStyle ?? "").toLowerCase();
    const configured = style.includes("לאגר") || style.includes("lager")
        ? specs.tolorances?.yeastDropMinPlatoLager : specs.tolorances?.yeastDropMinPlato;
    const threshold = Number(configured) > 0 ? Number(configured) : 6;
    const rate = (first - last) / separation;
    const minAgeDate = plusDays(brewedOn, 5)!;
    let dueDate: string | null = null;

    if (last < threshold) {
        // Already below the limit: age or a fresh stability check is the blocker.
        dueDate = rate >= 0 && rate < 1 ? minAgeDate : plusDays(today, 1);
    } else if (rate >= 0.1 && rate <= 4) {
        const daysToThreshold = Math.floor((last - threshold) / rate) + 1;
        dueDate = plusDays(lastDate, daysToThreshold);
    }
    if (!dueDate) return [];
    if (dueDate < minAgeDate) dueDate = minAgeDate;
    const interval = dayValue(dueDate)! - dayValue(today)!;
    if (interval < 1 || interval > 7) return [];

    return [{
        id: tank.id + ":non-hoppy-warm-yeast:" + dueDate,
        tankNumber: String(tank.tankNumber ?? tank.uid ?? tank.id),
        dueDate,
        title: "צפי להורדת שמרים חמה — בדיקת תנאים",
        basis: "מיכל סגור, בישול בן 5 ימים לפחות; יש לאמת פלאטו נמוך מ־" +
            threshold + "°P והאטה בירידת הסוכר ביום הבדיקה",
    }];
}
