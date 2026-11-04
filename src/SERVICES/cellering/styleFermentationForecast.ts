import type { StyleAverages, StyleAverageDay } from "../getAndPost/getStyleAverages";
import { batchDryHopThreshold } from "./dryHopThreshold";
import { getFermentationEndPlatoLimit } from "./fermentationEndPlato";
import { isCompletedYeastDrop } from "./coolingYeastTiming";
import { hasActualCooling } from "./neglectAfterCooling";
import {
    projectPlatoThresholdRecheck, projectCoolingReadinessCheck,
    type PlatoForecastTank, type PlatoForecastReading, type PlatoForecastSpecs,
    type PlatoThresholdHint,
} from "./platoThresholdForecast";
import type { SpecChart } from "../getAndPost/getSpecsFromFb";

type ForecastTank = PlatoForecastTank & { brewDate?: string | null };
type ForecastSpecs = PlatoForecastSpecs & { fermentationEndPlato?: Record<string, number> };

/** Only use days contributed to by at least three distinct brews with real Plato.
 * Historical styleAverages documents have only an overall batch count, so
 * they safely fall back to batch-specific slopes until the weekly rebuild.
 */
const MIN_DISTINCT_PLATO_BATCHES = 3;
const MAX_CALIBRATION_OFFSET = 5;
const MAX_HORIZON_DAYS = 7;

function utcDay(date: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const value = Date.parse(date + "T12:00:00Z");
    return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date
        ? Math.floor(value / 86400000) : null;
}
function brewDate(value: unknown): string | null {
    const text = String(value ?? "").trim();
    if (utcDay(text) !== null) return text;
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (!match) return null;
    const key = match[3] + "-" + match[2].padStart(2, "0") + "-" + match[1].padStart(2, "0");
    return utcDay(key) === null ? null : key;
}
function asPlato(value: unknown): number | null {
    if (value === "" || value === undefined || value === null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 30 ? numeric : null;
}
function measuredPlatoByDate(readings: PlatoForecastReading[], today: string) {
    const result = new Map<string, number>();
    for (const row of [...readings].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
        const day = /^\d{4}-\d{2}-\d{2}/.exec(String(row.id ?? ""))?.[0] ?? null;
        const plato = asPlato(row.plato);
        if (day && day <= today && plato !== null && utcDay(day) !== null) result.set(day, plato);
    }
    return result;
}
function reliablePlato(day: StyleAverageDay | undefined): number | null {
    if (!day || !Number.isInteger(day.platoBatchCount) ||
        Number(day.platoBatchCount) < MIN_DISTINCT_PLATO_BATCHES) return null;
    return asPlato(day.plato);
}
function hasRecordedDrop(readings: PlatoForecastReading[]): boolean {
    return readings.some((row) => isCompletedYeastDrop(row.notes));
}
function recordedCooling(readings: PlatoForecastReading[]): boolean {
    return readings.some((row) => hasActualCooling(String(row.notes ?? "")));
}
type StyleProjection = {
    currentAge: number;
    knownLatestDate: string | null;
    platoAtAge: (age: number) => number | null;
    evidence: string;
};

/** Curve day numbers are relative to a brew's calendar date.
 * Zero readings use the style mean. One (or more) fresh actual readings
 * vertically calibrate the mean. Never extrapolate missing style days.
 */
function styleProjection(
    tank: ForecastTank,
    readings: PlatoForecastReading[],
    today: string,
    average: StyleAverages | null | undefined,
): StyleProjection | null {
    const brewed = brewDate(tank.brewDate);
    const brewedIndex = brewed ? utcDay(brewed) : null;
    const todayIndex = utcDay(today);
    if (!average || brewedIndex === null || todayIndex === null || todayIndex < brewedIndex ||
        String(average.style).trim() !== String(tank.beerStyle ?? "").trim()) return null;

    const reliable = Object.values(average.days ?? {}).filter((day) =>
        reliablePlato(day) !== null
    ).length;
    if (reliable < 2) return null;
    const nowAge = todayIndex - brewedIndex;
    const observations = [...measuredPlatoByDate(readings, today)]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([date]) => {
            const at = utcDay(date)! - brewedIndex;
            return at >= 0 && nowAge - at <= 2;
        });
    const latest = observations.at(-1);
    let offset = 0;
    if (latest) {
        const measuredAge = utcDay(latest[0])! - brewedIndex;
        const expected = reliablePlato(average.days[String(measuredAge)]);
        if (expected === null) return null;
        offset = latest[1] - expected;
        // An anomalous batch should not be forced onto the style average.
        if (Math.abs(offset) > MAX_CALIBRATION_OFFSET) return null;
    }
    const basis = latest
        ? "עקומת ממוצע הסגנון לפי יום תסיסה, מותאמת לפלאטו שנמדד ב־" + latest[0]
        : "עקומת ממוצע הסגנון לפי יום תסיסה (טרם נמדד פלאטו באצווה)";
    return {
        currentAge: nowAge,
        knownLatestDate: latest?.[0] ?? null,
        platoAtAge: (age) => {
            const value = reliablePlato(average.days[String(age)]);
            return value === null ? null : Math.max(0, Math.min(30, value + offset));
        },
        evidence: basis + "; לפחות " + MIN_DISTINCT_PLATO_BATCHES + " אצוות שונות בכל יום ממוצע",
    };
}
function dateForAge(brewedOn: string, age: number): string {
    return new Date((utcDay(brewedOn)! + age) * 86400000).toISOString().slice(0, 10);
}

/** Predict one threshold check from non-linear style averages; not an instruction
 * to perform dry-hop or close a vent without fresh pressure/temperature.
 */
function projectedHopOrClose(
    tank: ForecastTank,
    readings: PlatoForecastReading[],
    today: string,
    specs: ForecastSpecs,
    curve: StyleProjection,
): PlatoThresholdHint[] {
    if (tank.stage?.name !== "בתסיסה") return [];
    const thresholdFromRecipe = batchDryHopThreshold(tank.beerStyle, specs.tolorances, tank);
    const isHoppy = thresholdFromRecipe !== null;
    const threshold = thresholdFromRecipe ?? (
        Number(specs.tolorances?.shutTankMinPlato) > 0 ? Number(specs.tolorances?.shutTankMinPlato) : 5
    );
    const notes = readings.filter((row) =>
        (String(row.id ?? "").slice(0, 10) <= today)
    ).map((row) => String(row.notes ?? "")).join(" ");
    if (isHoppy ? notes.includes("כשות") : /סגיר(?:ת|ה).*(?:נשם|לחץ|פורק)/.test(notes)) return [];

    const brewedOn = brewDate(tank.brewDate)!;
    for (let age = curve.currentAge + 1; age <= curve.currentAge + MAX_HORIZON_DAYS; age++) {
        const candidate = curve.platoAtAge(age);
        if (candidate === null || candidate >= threshold) continue;
        const dueDate = dateForAge(brewedOn, age);
        return [{
            id: tank.id + ":plato-recheck:" + dueDate,
            tankNumber: String(tank.tankNumber ?? tank.id),
            dueDate,
            title: isHoppy ? "צפי לדרייהופ — בדיקת תנאים" : "צפי לסגירת מיכל — בדיקת תנאים",
            basis: curve.evidence + "; סף " + threshold +
                "°P, צפי " + Number(candidate.toFixed(2)) +
                "°P. נדרשת מדידת פלאטו, טמפרטורה ולחץ לפני ביצוע",
        }];
    }
    return [];
}

/** Cooling is an estimated readiness REVIEW only. Actual cooling still requires
 * a completed prior warm yeast drop, real Plato stability and the style finish
 * limit; never predict those future operator actions as completed.
 */
function projectedCoolingReadiness(
    tank: ForecastTank,
    readings: PlatoForecastReading[],
    today: string,
    specs: ForecastSpecs,
    curve: StyleProjection,
): PlatoThresholdHint[] {
    if (tank.stage?.name !== "בתסיסה" || recordedCooling(readings) || !hasRecordedDrop(readings)) return [];
    const limit = getFermentationEndPlatoLimit(
        typeof tank.beerStyle === "string" || typeof tank.beerStyle === "number" ? tank.beerStyle : null,
        specs as SpecChart,
    );
    if (limit === null) return [];
    const lastDropDate = readings.filter((row) => isCompletedYeastDrop(row.notes))
        .map((row) => String(row.id ?? "").slice(0, 10)).filter((date) => utcDay(date) !== null && date <= today)
        .sort().at(-1);
    if (!lastDropDate) return [];

    const brewedOn = brewDate(tank.brewDate)!;
    for (let age = curve.currentAge + 1; age <= curve.currentAge + MAX_HORIZON_DAYS; age++) {
        const date = dateForAge(brewedOn, age);
        if (date <= lastDropDate) continue;
        const current = curve.platoAtAge(age);
        const following = curve.platoAtAge(age + 1);
        // Require an actual flat segment in the historical curve: a final-Plato
        // threshold crossing while still rapidly fermenting is not cooling readiness.
        if (current === null || following === null || current > limit ||
            Math.abs(current - following) > 0.35) continue;
        return [{
            id: tank.id + ":cooling-readiness:" + date,
            tankNumber: String(tank.tankNumber ?? tank.id),
            dueDate: date,
            title: "צפי לבדיקת מוכנות לקירור",
            basis: curve.evidence + "; סף סיום תסיסה " + limit +
                "°P, שינוי ממוצע יומי " + Number(Math.abs(current - following).toFixed(2)) +
                "°P. חובה לאמת יציבות בפועל והורדת שמרים לפני קירור",
        }];
    }
    return [];
}

/** Prefer supported historical non-linear style curves. If the relevant
 * milestone cannot be resolved, retain the established batch-local linear
 * predictor. Exactly one estimate per milestone is returned.
 */
export function projectHybridFermentationMilestones(
    tank: ForecastTank,
    readings: PlatoForecastReading[],
    today: string,
    specs: ForecastSpecs,
    average: StyleAverages | null | undefined,
): PlatoThresholdHint[] {
    if (tank.stage?.name !== "בתסיסה") return [];
    const curve = styleProjection(tank, readings, today, average);
    const hopOrClose = curve ? projectedHopOrClose(tank, readings, today, specs, curve) : [];
    const cooling = curve ? projectedCoolingReadiness(tank, readings, today, specs, curve) : [];
    // A well-supported non-linear curve is authoritative even when its next
    // threshold crossing is beyond this week's horizon. Use a local straight
    // line only when style evidence is absent or insufficient.
    const futureCoverage = curve
        ? Array.from({ length: MAX_HORIZON_DAYS }, (_, index) => curve.platoAtAge(curve.currentAge + index + 1))
            .filter((value) => value !== null).length
        : 0;
    const useLinearFallback = futureCoverage < 5;
    return [
        ...(hopOrClose.length ? hopOrClose :
            useLinearFallback ? projectPlatoThresholdRecheck(tank, readings, today, specs) : []),
        ...(cooling.length ? cooling :
            useLinearFallback ? projectCoolingReadinessCheck(tank, readings, today, specs) : []),
    ];
}
