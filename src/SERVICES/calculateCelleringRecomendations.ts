import { getPlannedPackagingContainerNumbers } from "../components/PackagingReportsView";
import { getBrewAge } from "../components/TankCard";
import { type SpecChart } from "./getSpecsFromFb";
import type { TankStageInfo } from "./tankstage";



export type Measurement = {
    id?: string | number | null;
    temp?: string | number | null;
    plato?: string | number | null;
    pH?: string | number | null;
    pressure?: string | number | null;
    carbonation?: string | number | null;
    notes?: string | number | null;
    volume?: string | number | null;
};

export function isCarbonationOutOfRange(
    carbonation: string | number | null | undefined,
    style: string,
    givenSpecs: SpecChart
): { outOfSpec: boolean, importance: number } {
    const specs: Record<string, number> = givenSpecs?.carbonation || {
        ipa: 2.45,
        פייל: 2.4,
        לאגר: 2.5,
        הופי: 2.5,
        חיטה: 2.5,
        סטאוט: 2.2,
        other: 2.45
    };

    const value = Number(carbonation);

    if (!Number.isFinite(value)) {
        return { outOfSpec: false, importance: 1 };
    }

    const normalizedStyle =
        String(style || "")
            .trim()
            .toLowerCase()
            .split(/\s+/)[0];;

    const target =
        specs[normalizedStyle] ?? specs.other;
    const tolerance = givenSpecs.tolorances.carbonation ?? 0.04;
    const outOfSpec =
        value >= target + tolerance ||
        value <= target - tolerance;
    let howBad = 1;
    if (outOfSpec) howBad = 2;
    if (value >= target + 0.1 || value <= target - 0.1) {
        howBad = 3
    }
    // else if (value >= target + tolerance + 0.03 || value <= target - tolerance + 0.03) {
    //     howBad = 2
    // }

    const resault = {
        outOfSpec,
        importance: howBad
    }
    return resault;
};

export function isPressureOutOfRange(

    pressure: string | number | null | undefined,
    style: string | null,
    givenSpecs: SpecChart
): { onSpec: boolean, howBad: number } {
    const pressureSpecs: Record<string, number> = givenSpecs?.pressure || {
        ipa: 1.6,
        פייל: 1.7,
        לאגר: 1.1,
        הופי: 1.1,
        חיטה: 1.6,
        סטאוט: 1.5,
        other: 1.5
    };

    const value = Number(pressure);

    if (!Number.isFinite(value)) {
        return { howBad: 0, onSpec: false };
    }

    const normalizedStyle =
        String(style || "")
            .trim()
            .toLowerCase()
            .split(/\s+/)[0];;
    const target =
        pressureSpecs[normalizedStyle] ?? pressureSpecs.other;
    const tolerance = givenSpecs.tolorances.pressure ?? 0.02;
    const onSpec = value === target || (value <= target + tolerance && value >= target - tolerance)
    let howBad = 0;
    if (onSpec) howBad = 1;
    if (value >= target + tolerance + 0.04 || value <= target - tolerance - 0.04) {
        howBad = 3
    }
    if ((value > target + tolerance && value < target + tolerance + 0.04) || (value < target - tolerance && value > target - tolerance - 0.04)) {
        howBad = 2
    }

    const resault = {
        onSpec,
        howBad
    }
    return resault;
};

type YeastDropType = "warm" | "cold";

export type YeastDrop = {
    amount: number;
    date: string;
    type: YeastDropType;
    note: string;
};

const HEBREW_NUMBERS: Record<string, number> = {
    "אפס": 0,
    "אחד": 1, "אחת": 1,
    "שניים": 2, "שתיים": 2, "שני": 2, "שתי": 2,
    "שלוש": 3, "שלושה": 3,
    "ארבע": 4, "ארבעה": 4,
    "חמש": 5, "חמישה": 5,
    "שש": 6, "שישה": 6,
    "שבע": 7, "שבעה": 7,
    "שמונה": 8,
    "תשע": 9, "תשעה": 9,
    "עשר": 10, "עשרה": 10,
    "אחד עשר": 11, "אחת עשרה": 11, "אחד עשרה": 11,
    "שנים עשר": 12, "שתים עשרה": 12, "שניים עשר": 12, "שתי עשרה": 12,
    "שלושה עשר": 13, "שלוש עשרה": 13,
    "ארבעה עשר": 14, "ארבע עשרה": 14,
    "חמישה עשר": 15, "חמש עשרה": 15,
    "שישה עשר": 16, "שש עשרה": 16,
    "שבעה עשר": 17, "שבע עשרה": 17,
    "שמונה עשר": 18, "שמונה עשרה": 18,
    "תשעה עשר": 19, "תשע עשרה": 19,
    "עשרים": 20,
};

type TankSize = "single" | "double" | "triple";

const YEAST_DROP_SPECS: Record<
    string,
    Partial<Record<TankSize, { warm: number; cold: number }>>
> = {
    ipa: { double: { warm: 8, cold: 8 }, triple: { warm: 12, cold: 12 } },
    פייל: { double: { warm: 7, cold: 7 }, triple: { warm: 8, cold: 8 } },
    חיטה: { single: { warm: 1, cold: 1 }, double: { warm: 2, cold: 2 }, triple: { warm: 4, cold: 4 } },
    לאגר: { triple: { warm: 7, cold: 7 } },
    הופי: { double: { warm: 7, cold: 5 }, triple: { warm: 7, cold: 6 } },
    סטאוט: { single: { warm: 3, cold: 1 } },
};

function getTankSize(tankNumber: number | undefined): TankSize | null {
    if (!tankNumber) return null;
    if (tankNumber >= 2 && tankNumber <= 4) return "single";
    if (tankNumber >= 5 && tankNumber <= 8) return "double";
    if (tankNumber >= 9 && tankNumber <= 19) return "triple";
    return null;
}

function getYeastDropSpec(
    beerStyle: string,
    tankNumber: number | undefined,
    type: YeastDropType
): number | null {
    const size = getTankSize(tankNumber);
    if (!size) return null;

    const normalized = String(beerStyle || "").trim().toLowerCase();
    let styleKey: string | null = null;

    if (normalized.includes("ipa")) styleKey = "ipa";
    else if (normalized.includes("פייל") || normalized.includes("pale")) styleKey = "פייל";
    else if (normalized.includes("חיטה") || normalized.includes("wheat")) styleKey = "חיטה";
    else if (normalized.includes("הופי") && normalized.includes("לאגר")) styleKey = "הופי";
    else if (normalized.includes("hoppy") && normalized.includes("lager")) styleKey = "הופי";
    else if (normalized.includes("לאגר") || normalized.includes("lager")) styleKey = "לאגר";
    else if (normalized.includes("סטאוט") || normalized.includes("stout")) styleKey = "סטאוט";

    if (!styleKey) return null;

    return YEAST_DROP_SPECS[styleKey]?.[size]?.[type] ?? null;
}

function normalizeHebrewNumberText(value: string): string {
    return value
        .replace(/(\d)½/g, "$1.5")
        .replace(/(\d)¼/g, "$1.25")
        .replace(/(\d)¾/g, "$1.75")
        .replace(/(?<!\d)½/g, "0.5")
        .replace(/(?<!\d)¼/g, "0.25")
        .replace(/(?<!\d)¾/g, "0.75")
        .replace(/,/g, ".")
        .replace(/[־–—-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function parseHebrewInteger(value: string): number | null {
    const normalized = normalizeHebrewNumberText(value);
    if (normalized in HEBREW_NUMBERS) {
        return HEBREW_NUMBERS[normalized];
    }
    return null;
}

const BARE_FRACTIONS: Record<string, number> = {
    "חצי": 0.5,
    "רבע": 0.25,
    "שלושת רבעי": 0.75,
    "שלושה רבעים": 0.75,
    "קצת": 0.4,
    "מעט": 0.4,
    "פסע": 0.4,
};
const FRACTION_WORDS = Object.keys(BARE_FRACTIONS).sort((a, b) => b.length - a.length);
const FRACTION_ALT = FRACTION_WORDS.join("|");

function parseYeastAmount(value: string): number | null {
    if (!value) return null;

    let text = normalizeHebrewNumberText(value);

    if (text in BARE_FRACTIONS) {
        return BARE_FRACTIONS[text];
    }

    const numericMatch = text.match(
        new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:ו)?\\s*(${FRACTION_ALT})?$`)
    );
    if (numericMatch) {
        const base = Number(numericMatch[1]);
        if (!Number.isFinite(base)) return null;
        const fraction = numericMatch[2];
        return fraction ? base + (BARE_FRACTIONS[fraction] ?? 0) : base;
    }

    const fractionMatch = text.match(new RegExp(`^(.+?)\\s*ו(${FRACTION_ALT})$`));
    if (fractionMatch) {
        const integerPart = parseHebrewInteger(fractionMatch[1]);
        if (integerPart !== null) {
            return integerPart + (BARE_FRACTIONS[fractionMatch[2]] ?? 0);
        }
    }

    const integer = parseHebrewInteger(text);
    if (integer !== null) return integer;

    return null;
}

const HEBREW_LETTER = "א-ת";
const BUCKET_WORDS = ["דליים", "דליי", "דלי"];
const BUCKET_ALT = BUCKET_WORDS.join("|");

// function findBucketWordIndex(text: string): number {
//     const regex = new RegExp(
//         `(?<![${HEBREW_LETTER}])(?:${BUCKET_ALT})(?![${HEBREW_LETTER}])`
//     );
//     const match = text.match(regex);
//     return match ? (match.index as number) : -1;
// }

function findBucketMatch(text: string): { index: number; word: string } | null {
    const regex = new RegExp(
        `(?<![${HEBREW_LETTER}])(${BUCKET_ALT})(?![${HEBREW_LETTER}])`
    );
    const match = text.match(regex);
    if (!match) return null;
    return { index: match.index as number, word: match[1] };
}

export function parseYeastDropAmount(notes: string | number | null | undefined): number | null {
    if (notes === null || notes === undefined) return null;

    const original = String(notes);
    const text = normalizeHebrewNumberText(original);

    const numericMatch = text.match(
        new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:ו)?\\s*(?:${BUCKET_ALT})`)
    );
    if (numericMatch) {
        return Number(numericMatch[1]);
    }

    const bucketMatch = findBucketMatch(text);

    if (bucketMatch) {
        const { index: bucketIndex, word: bucketWord } = bucketMatch;
        const beforeBuckets = text.slice(0, bucketIndex).trim();
        const words = beforeBuckets.split(" ").filter(Boolean);

        for (let count = Math.min(4, words.length); count >= 1; count--) {
            const candidate = words.slice(words.length - count).join(" ");
            const parsed = parseYeastAmount(candidate);
            if (parsed !== null) return parsed;
        }

        let afterBucket = text
            .slice(bucketIndex)
            .replace(new RegExp(`^(?:${BUCKET_ALT})`), "")
            .replace(/^\s*שמרים?/, "")
            .replace(/^[\s:\-–—]+/, "");
        // חשוב: לא לפצל על "." כדי לא לשבור מספרים עשרוניים כמו 0.7
        afterBucket = afterBucket.split(/[,;]/)[0].trim();

        if (afterBucket) {
            const parsed = parseYeastAmount(afterBucket);
            if (parsed !== null) return parsed;
        }

        // "דלי" ביחיד בלי כמות מפורשת = דלי אחד
        if (bucketWord === "דלי") {
            return 1;
        }
    }

    const actionMatch = text.match(
        /(?:הורדת|הורדתי|להוריד|הוצאת|הוצאתי|להוציא)\s+(.+?)(?=\s+(?:דל|שמר)|$)/
    );
    if (actionMatch) {
        const parsed = parseYeastAmount(actionMatch[1]);
        if (parsed !== null) return parsed;
    }

    return null;
}



function getMeasurementDate(id: string | number | null | undefined): string | null {
        if (id === null || id === undefined) {
            return null;
        }
        const idString = String(id);

        // Expected format:
        // 2026-07-31_1355

        const match = idString.match(/^(\d{4}-\d{2}-\d{2})_\d{4}$/);

        if (!match) {
            console.warn("Invalid measurement ID format:", idString);
            return null;
        }

        return match[1];
    }

export function extractYeastDrops(measurements: Measurement[]): YeastDrop[] {
    const sorted = [...measurements].sort((a, b) =>
        String(a.id ?? "").localeCompare(String(b.id ?? ""))
    );

    return sorted
        .map((measurement) => {
            const note = String(measurement.notes ?? "");
            if (!note.includes("שמרים") && !note.includes("שמרי")) return null;

            const amount = parseYeastDropAmount(note);
            if (amount === null) return null;

            const date = getMeasurementDate(measurement.id);
            if (!date) return null;

            const temp = Number(measurement.temp);
            const type: YeastDropType = Number.isFinite(temp) && temp <= 9 ? "cold" : "warm";

            return { amount, date, type, note };
        })
        .filter((drop): drop is YeastDrop => drop !== null);
}

export async function calcCelleringRecomendations(measurements: Measurement[],
    beerStyle: string | number | undefined | null,
    brewDate: string, givenSpecs: SpecChart, stage: TankStageInfo, tankNumber: number | undefined,
    TankCardUse: boolean) {

    const sortedMeasurements = [...measurements].sort((a, b) => {

        const dateA = String(a.id ?? "");
        const dateB = String(b.id ?? "");

        return dateA.localeCompare(dateB);
    });
    const brewAge = getBrewAge(brewDate);
    // =======  =====================================================
    // GET LATEST MEASUREMENTS
    // ============================================================

    const lastMeasurement: Measurement =
        sortedMeasurements[sortedMeasurements.length - 1];

    const yesterdayMeasurement: Measurement =
        sortedMeasurements[sortedMeasurements.length - 2];

    const toDaysAgoMeasurement: Measurement =
        sortedMeasurements[sortedMeasurements.length - 3];
    if (!lastMeasurement) {


        return null
    }
    // ============================================================
    // CHECK IF LAST MEASUREMENT IS FROM TODAY
    // ============================================================


    const today = new Date().getDay();
    const corrected = today === 0 ? 1 : today + 1;
    const nextWeekPack = await getPlannedPackagingContainerNumbers();

    function getTodayDateString(): string {

        const today = new Date();

        const year =
            today.getFullYear();

        const month =
            String(today.getMonth() + 1)
                .padStart(2, "0");

        const day =
            String(today.getDate())
                .padStart(2, "0");

        return `${year}-${month}-${day}`;
    }
    
    function formatDateToDDMMYYYY(date: string | null | undefined): string | null {
        if (!date) {
            return null;
        }

        const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);

        if (!match) {
            console.warn("Invalid date format:", date);
            return null;
        }

        const [, year, month, day] = match;

        return `${day}/${month}/${year}`;
    }

    const lastMeasurementDate =
        getMeasurementDate(
            lastMeasurement?.id
        );

    const todayDate =
        getTodayDateString();


    // ============================================================
    // LAST MEASUREMENT UP TO DATE
    // ============================================================

    const lastMessurmentUpToDate = {
        display: false,
        req:
            !!lastMeasurementDate &&
            lastMeasurementDate !== todayDate,

        reason:
            lastMeasurementDate &&
                lastMeasurementDate !== todayDate
                ? `שים לב - המדידה האחרונה היא מתאריך ${formatDateToDDMMYYYY(lastMeasurementDate)} ולא מהיום. ההמלצות הן בהתאם למדידה האחרונה. מומלץ לבצע סבב מדידות יומי בטרם בדיקת המלצות.`
                : "",

        importance:
            lastMeasurementDate &&
                lastMeasurementDate !== todayDate
                ? 2
                : 0
    };
    function getDaysSinceDate(dateString: string): number {
        const date = new Date(`${dateString}T00:00:00`);
        const today = new Date();

        today.setHours(0, 0, 0, 0);

        const diff =
            today.getTime() - date.getTime();

        return Math.floor(
            diff / (1000 * 60 * 60 * 24)
        );
    }
    const style =
        String(beerStyle || "")
            .trim()
            .toLowerCase();


    const isHoppy =
        style.includes("ipa") ||
        style.includes("פייל") ||
        style.includes("הופי") ||
        style.includes("pale") ||
        style.includes("hoppy");
    const normalizedStyle = String(style || "").trim().toLowerCase();
    const isLager = normalizedStyle.includes("לאגר");


    const dryHopMeasurement =
        measurements.find(
            measurement =>
                String(measurement.notes || "")
                    .includes("כשות")
        );
    const CooledHopMeasurement =
        measurements.find(
            measurement =>
                String(measurement.notes || "")
                    .includes("קירור")
        );

    const dryHopDate =
        getMeasurementDate(dryHopMeasurement?.id);
    const CooldDate =
        getMeasurementDate(CooledHopMeasurement?.id);
    const dryhopped =
        measurements.some(
            measurement =>
                String(
                    measurement.notes || ""
                ).includes("כשות")
        );
    const yeastDroppedOnce =
        measurements.some(
            measurement =>
                String(
                    measurement.notes || ""
                ).includes("הורדת שמרים")
        ) || measurements.some(
            measurement =>
                String(
                    measurement.notes || ""
                ).includes("שמרים"));

    const requiresDryHop = {
        display: true,
        req: isHoppy &&
            lastMeasurement?.plato &&
            Number(lastMeasurement?.plato) < (givenSpecs.tolorances.dryHopMinPlato || 8) &&
            Number(lastMeasurement?.temp) > 9 &&
            Number(lastMeasurement?.pressure) <= 0 &&
            !dryhopped &&
            stage.name === "בתסיסה",
        reason: "מומלץ לבצע דריי-הופ",
        importance: 1
    }
    const pressureIsclosed = (sortedMeasurements.map((m) => m.notes).join(",").includes("סגירת") ||
        sortedMeasurements.map((m) => m.notes).join(",").includes("סגירה"))
    const requiresPresureClose = {
        display: true,
        req: !isHoppy &&
            lastMeasurement?.plato &&
            Number(lastMeasurement?.plato) < (givenSpecs.tolorances.shutTankMinPlato || 5) &&
            Number(lastMeasurement?.temp) > 9 &&
            Number(lastMeasurement?.pressure) <= 0 && stage.name === "בתסיסה" && !pressureIsclosed,
        reason: "מומלץ לבצע סגירת לחץ",
        importance: 1
    }


    const currentPlato = Number(lastMeasurement?.plato);

    const dryHopAge =
        dryHopDate !== null
            ? getDaysSinceDate(dryHopDate)
            : null;

    let requiresWarmYeastDrop = {
        display: true,
        req: false,
        reason: undefined as string | undefined,
        importance: 1
    };

    const yeastDropSpec = isLager ? givenSpecs.tolorances.yeastDropMinPlatoLager : givenSpecs.tolorances.yeastDropMinPlato;

    // ============================================================
    // HOPPY BEER - WARM YEAST DROP AFTER DRY HOP
    // ============================================================
    if (
        isHoppy &&
        dryHopAge === 5 &&
        dryhopped &&
        !yeastDroppedOnce &&
        !requiresDryHop.req &&
        stage.name === "בתסיסה"
    ) {

        requiresWarmYeastDrop = {
            display: true,
            req: true,
            reason: "מומלץ לבצע הוצאת שמרים- 5 ימים אחרי דרי הופ",
            importance: 1
        };
    }


    else if (
        isHoppy &&
        dryHopAge !== null &&
        dryHopAge < 5 &&
        dryhopped &&
        !yeastDroppedOnce &&
        !requiresDryHop.req &&
        stage.name === "בתסיסה"
    ) {

        requiresWarmYeastDrop = {
            display: false,
            req: true,
            reason:
                `מומלץ לבצע הורדת שמרים בעוד ${5 - dryHopAge} ימים- אחרי דרייהופ`,
            importance: 0
        };
    }


    // ============================================================
    // NON-HOPPY BEER
    // ============================================================
    else if (
        !isHoppy &&
        brewAge !== null &&
        brewAge >= 3 &&
        !dryhopped &&
        !yeastDroppedOnce &&
        !requiresDryHop.req &&
        yesterdayMeasurement &&
        Number(currentPlato) < (yeastDropSpec || 6) &&
        pressureIsclosed
    ) {
        const yesterdayPlato =
            Number(yesterdayMeasurement?.plato);

        if (
            Number(yesterdayPlato) > 0 &&
            Number.isFinite(yesterdayPlato) &&
            Number.isFinite(currentPlato) &&
            yesterdayPlato - currentPlato < 1 &&
            brewAge >= 5 &&
            stage.name === "בתסיסה"
        ) {
            requiresWarmYeastDrop = {
                display: true,
                req: true,
                reason: lastMessurmentUpToDate.req ?
                    `מומלץ לבצע הורדת שמרים - הסוכר במדידה אחרונה ${currentPlato}P°, במדידה קודמת ${yesterdayPlato}P°` :
                    `מומלץ לבצע הורדת שמרים - הסוכר היום ${currentPlato}P°, אתמול ${yesterdayPlato}P°`,
                importance: 1
            };
        }
    }
    const CoolAge =
        CooldDate !== null
            ? getDaysSinceDate(CooldDate)
            : null;
    const lastTemp = lastMeasurement?.temp;
    const oldTemp = toDaysAgoMeasurement?.temp;
    const lastNote = lastMeasurement?.notes?.toString();
    const requiersYeastDropAfterCooling = {
        display: true,
        req:
            CoolAge === 2 &&
            lastTemp != null &&
            oldTemp != null &&
            !lastNote?.includes("שמרים") &&
            // lastTemp > oldTemp &&
            stage.name === "קר",
        reason: "מומלץ לבצע הורדת שמרים- (יומיים אחרי קירור)",
        importance: 1
    }

    const carbRes = lastMeasurement.carbonation;
    const alreadyadjustedPToday = lastNote?.includes("הורדת לחץ") || lastNote?.includes("העלאת לחץ") || lastNote?.includes("להוריד לחץ") || lastNote?.includes("להעלות לחץ");
    const tookCare = carbRes && alreadyadjustedPToday;
    let requiresCarbTest = {
        display: false,
        req: false,
        reason: undefined as string | undefined,
        importance: 1
    };

    if (
        CoolAge === 1 &&
        yesterdayMeasurement?.temp != null &&
        lastMeasurement?.temp != null &&
        yesterdayMeasurement.temp > lastMeasurement.temp &&
        !lastMeasurement?.carbonation &&
        stage.name === "קר"
    ) {
        requiresCarbTest.display = true;
        requiresCarbTest.req = true;
        requiresCarbTest.reason = "מומלץ לבצע בדיקת גיזוז ולפתוח ברזי גליקול- (יום אחרי קירור)",
            requiresCarbTest.importance = 1;
    }
    const YeastDroppedToday = lastNote?.includes("שמרים");
    const requiiersWedYeastDropOnThus = {
        req: false,
        display: false,
        reason: undefined as string | undefined,
        importance: 1
    }
    if (CoolAge !== null && CoolAge > 1 && stage.name === "קר") {
        const carbonationSpecToDaysAgo = isCarbonationOutOfRange(toDaysAgoMeasurement?.carbonation, style, givenSpecs)
        if (toDaysAgoMeasurement?.carbonation && !lastMeasurement?.carbonation) {
            if (carbonationSpecToDaysAgo?.outOfSpec) {
                requiresCarbTest.display = true,
                    requiresCarbTest.req = !tookCare;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה ההאחרונה לא תקין (${toDaysAgoMeasurement?.carbonation})- מומלץ לבצע בדיקת גיזוז חוזרת ` :
                    `הגיזוז לפני יומיים לא תקין (${toDaysAgoMeasurement?.carbonation})- מומלץ לבצע בדיקת גיזוז חוזרת `
                requiresCarbTest.importance = carbonationSpecToDaysAgo?.importance
            } else {
                requiresCarbTest.display = false,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה ההאחרונה תקין (${toDaysAgoMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת` :
                    `הגיזוז לפני יומיים תקין (${toDaysAgoMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת`
                requiresCarbTest.importance = carbonationSpecToDaysAgo?.importance
            }
        }
        const CarbonationSpecYesterday = isCarbonationOutOfRange(yesterdayMeasurement?.carbonation, style, givenSpecs)
        if (yesterdayMeasurement?.carbonation && !lastMeasurement?.carbonation) {
            if (CarbonationSpecYesterday.outOfSpec) {
                requiresCarbTest.display = true,
                    requiresCarbTest.req = !tookCare;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה האחרונה היה לא תקין (${yesterdayMeasurement?.carbonation})- מומלץ לבצע בדיקת גיזוז חוזרת ` :
                    `הגיזוז אתמול היה לא תקין (${yesterdayMeasurement?.carbonation})- מומלץ לבצע מחר בדיקת גיזוז חוזרת `,
                    requiresCarbTest.importance = CarbonationSpecYesterday.importance
            } else {
                requiresCarbTest.display = false,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה האחרונה היה תקין (${yesterdayMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת` :
                    `הגיזוז אתמול היה תקין (${yesterdayMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת`

            }
        }
        const carbonationSpecToDay = isCarbonationOutOfRange(lastMeasurement?.carbonation, style, givenSpecs)
        if (lastMeasurement?.carbonation) {
            if (carbonationSpecToDay.outOfSpec) {
                requiresCarbTest.display = true,
                    requiresCarbTest.req = !tookCare;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה ההאחרונה לא תקין (${lastMeasurement?.carbonation})- מומלץ לבצע שינוי לחץ בהתאם, או לוודא שבוצע שינוי לחץ ` :
                    `הגיזוז היום לא תקין (${lastMeasurement?.carbonation})- מומלץ לבצע שינוי לחץ בהתאם, או לוודא שבוצע שינוי לחץ `
                requiresCarbTest.importance = carbonationSpecToDay.importance
            } else {
                requiresCarbTest.display = false,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה האחרונה תקין (${lastMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת ` :
                    `הגיזוז היום תקין (${lastMeasurement?.carbonation})-ניתן להמתין עם בדיקת גיזוז נוספת `
                requiresCarbTest.importance = carbonationSpecToDay.importance
            }
        }

        if (stage.name === "קר" && (corrected === 4) && tankNumber && nextWeekPack.includes(tankNumber) && carbRes === null) {
            requiresCarbTest.display = true,
                requiresCarbTest.req = true;
            requiresCarbTest.reason = `לפי נתוני היומן- מיכל ${tankNumber} מתוכנן לרדת שבוע הבא. מומלץ לבצע בדיקת גיזוז`
            requiresCarbTest.importance = 1;
        }
        if (stage.name === "קר" && (corrected === 5) && tankNumber && nextWeekPack.includes(tankNumber) && carbRes === null) {
            // console.log("tank number", tankNumber, "next week pack", nextWeekPack, "carb res", carbRes)
            if ((!lastMessurmentUpToDate.req && yesterdayMeasurement?.carbonation === null) ||
                (lastMessurmentUpToDate.req && carbRes === null)) {
                console.log("tank number", tankNumber, "carb res",
                    carbRes, lastMeasurement.carbonation, "last measurement up to date", lastMessurmentUpToDate.req,
                    "yesterday measurement carbonation", yesterdayMeasurement?.carbonation)
                requiresCarbTest.display = true,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = `לפי נתוני היומן- מיכל ${tankNumber} מתוכנן לרדת שבוע הבא. אתמול לא בוצעה בדיקת גיזוז. מומלץ לבצע בדיקת גיזוז`
                requiresCarbTest.importance = 1;
            }
        }
        if (stage.name === "קר" && (corrected === 5) && tankNumber && nextWeekPack.includes(tankNumber) && !YeastDroppedToday) {
            requiresCarbTest.display = true,
                requiresCarbTest.req = true;
            requiresCarbTest.reason = `לפי נתוני היומן- מיכל ${tankNumber} מתוכנן לרדת שבוע הבא. מומלץ להוריד שמרים`
            requiresCarbTest.importance = 1;
        }


        // ============================================================
        // LAST INVALID CARBONATION - NO TEST FOR MORE THAN 2 DAYS
        // ============================================================
        if (!requiresCarbTest.req && stage.name === "קר") {
            const lastCarbonationMeasurement =
                [...sortedMeasurements]
                    .reverse()
                    .find(
                        measurement =>
                            measurement.carbonation !== null &&
                            measurement.carbonation !== undefined &&
                            Number.isFinite(
                                Number(measurement.carbonation)
                            )
                    );

            if (lastCarbonationMeasurement) {

                const lastCarbonationDate =
                    getMeasurementDate(
                        lastCarbonationMeasurement.id
                    );

                const carbonationAge =
                    lastCarbonationDate !== null
                        ? getDaysSinceDate(lastCarbonationDate)
                        : null;

                const lastCarbonationSpec =
                    isCarbonationOutOfRange(
                        lastCarbonationMeasurement.carbonation,
                        style, givenSpecs
                    );

                if (
                    carbonationAge !== null &&
                    carbonationAge > 2 &&
                    lastCarbonationSpec.outOfSpec
                ) {
                    requiresCarbTest.req = true;
                    requiresCarbTest.display = true;
                    requiresCarbTest.reason =
                        `הגיזוז האחרון שנמדד לא תקין (${lastCarbonationMeasurement.carbonation})- לא נמדד גיזוז יותר מיומיים, מומלץ לבצע בדיקת גיזוז חוזרת`;

                    requiresCarbTest.importance =
                        lastCarbonationSpec.importance;
                }
            }
        }
    }
    const requiersDiacytelRest = {
        req: isLager && lastMeasurement?.plato && Number(lastMeasurement?.plato) < (givenSpecs.tolorances.dycitalRestMinPlato || 8) &&
            Number(lastMeasurement?.temp) > 9 && Number(lastMeasurement?.temp) < 13 &&
            stage.name === "בתסיסה" &&
            !measurements.some(
                measurement =>
                    String(
                        measurement.notes || ""
                    ).includes("דיאציטיל") &&
                    !measurements.some(
                        measurement =>
                            String(
                                measurement.notes || ""
                            ).includes("מנוחה")
                    )
            ),
        display: true,
        reason: `מומלץ לבצע מנוחת דיאציטיל (סוכר ${lastMeasurement?.plato})`,
        importance: 1
    }
    function formatMeasurementDate(
        id: string | number | null | undefined
    ): string | null {

        if (id === null || id === undefined) {
            return null;
        }

        const match = String(id).match(
            /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/
        );

        if (!match) {
            return null;
        }

        const [, year, month, day, hour, minute] = match;

        return `${day}/${month}/${year} בשעה ${hour}:${minute}`;
    }


    const lastYeast = sortedMeasurements.findLast(
        measurement =>
            String(measurement.notes ?? "").includes("שמרים")
    );

    const lastCarb = sortedMeasurements.findLast(
        measurement =>
            measurement.carbonation !== null &&
            measurement.carbonation !== undefined &&
            Number.isFinite(Number(measurement.carbonation))
    );
    const lastCarbDate =
        formatMeasurementDate(lastCarb?.id);

    const lastYeastDate =
        formatMeasurementDate(lastYeast?.id);
    const neglected = () => {

        // ============================================================
        // HOT TANK
        // ============================================================

        // If the beer was never cooled,
        // neglect logic does not apply.
        if (CoolAge === null || stage.name === "בתסיסה") {
            return {
                display: false,
                req: false,
                importance: 0,
                reason: ""
            };
        }


        // ============================================================
        // LAST RELEVANT ACTION
        // ============================================================

        const carbDate =
            getMeasurementDate(lastCarb?.id);

        const yeastDate =
            getMeasurementDate(lastYeast?.id);


        const carbAge =
            carbDate !== null
                ? getDaysSinceDate(carbDate)
                : null;

        const yeastAge =
            yeastDate !== null
                ? getDaysSinceDate(yeastDate)
                : null;


        // ============================================================
        // COLD TANK - NO CARB + NO YEAST
        // ============================================================

        if (
            carbAge === null &&
            yeastAge === null &&
            CoolAge > 5
        ) {

            return {
                display: true,
                req: true,
                importance: 3,
                reason: ""
            };
        }


        // ============================================================
        // LAST ACTION RESETS THE CLOCK
        // ============================================================

        const daysSinceLastAction =
            Math.min(
                carbAge ?? Infinity,
                yeastAge ?? Infinity
            );


        // ============================================================
        // NEGLECT LEVEL
        // ============================================================

        let importance = 0;

        if (
            daysSinceLastAction >= 5 &&
            daysSinceLastAction <= 7
        ) {
            importance = 2;
        }

        else if (
            daysSinceLastAction > 7
        ) {
            importance = 3;
        }


        return {
            req: importance > 0,
            display: importance > 0,
            importance,
            reason: ""
        };
    };


    const neglectedStatus = neglected();


    // ============================================================
    // NEGLECT MESSAGE
    // ============================================================

    let neglectedMsg = "⚠️ המיכל מרגיש מוזנח!";

    if (neglectedStatus.req) {

        if (lastCarbDate) {

            neglectedMsg +=
                ` גיזוז אחרון היה ב-${lastCarbDate}.`;

        } else {

            neglectedMsg +=
                " לא נמצא גיזוז קודם.";
        }


        if (lastYeastDate) {

            neglectedMsg +=
                ` הורדת שמרים אחרונה הייתה ב-${lastYeastDate}.`;

        } else {

            neglectedMsg +=
                " לא נמצאה הורדת שמרים קודמת.";
        }


        neglectedMsg +=
            " מומלץ לבצע בדיקת גיזוז ולהוריד שמרים!";
    }
    neglectedStatus.reason = neglectedMsg
    const readyToCoolDown = (
        lastMeasurement?.plato === toDaysAgoMeasurement?.plato &&
        Number(yesterdayMeasurement?.plato) >= Number(lastMeasurement?.plato) && stage.name === "בתסיסה"

    )
    let readyToCoolDownText = "";
    let coolDownDisplay = readyToCoolDown;
    let dispCoolDownGenerallRec = false;
    if (!readyToCoolDown && lastMeasurement?.plato && stage.name === "בתסיסה") {
        readyToCoolDownText = "המיכל עוד לא מוכן לקירור -עדיין לא הסתיימה התסיסה"
        if (Number(lastMeasurement.plato) < 5) coolDownDisplay = true;
    }
    if (readyToCoolDown) {
        if (!yeastDroppedOnce) {
            readyToCoolDownText = "המיכל סיים לתסוס, מומלץ לבצעה הורדת שמרים לפני קירור";
            dispCoolDownGenerallRec = true;
        }
        if (CooldDate) {
            if (Number(lastMeasurement.temp) > 9) { readyToCoolDownText = "לפי הרישום המיכל כבר קורר- במדידת טמפ' זה יעודכן, מומלץ לוודא" }
            else coolDownDisplay = false
        } else {
            if (Number(lastMeasurement.temp) > 9) readyToCoolDownText = "המיכל מוכן לקירור. מומלץ לכוון טמפ' לקירור ולשנוק את ברזי` הגליקול";
            dispCoolDownGenerallRec = true;

        }

    }
    const requiresToCoolDown = {
        display: dispCoolDownGenerallRec,
        req: coolDownDisplay,
        reason: readyToCoolDownText,
        importance: !readyToCoolDown ? 0 : 1,
    }


    const pressureSpecs: Record<string, number> = givenSpecs.pressure;


    const isPressureOutOfRangeVal = isPressureOutOfRange(lastMeasurement?.pressure, style, givenSpecs)

    const alreadyadjustedPtargetToday = lastNote?.includes("כיוון פורק") || lastNote?.includes("לכוון פורק");
    const requiredPressureAdjustment = {
        display: true,
        req: stage.name === "בתסיסה" && !alreadyadjustedPtargetToday && Number(lastMeasurement?.pressure) > 0 && Number(lastMeasurement?.temp) > 9 && !isPressureOutOfRangeVal.onSpec,
        reason: `מומלץ לכוון פורק ל ${pressureSpecs[normalizedStyle]}, הלחץ כרגע ${pressureSpecs[normalizedStyle] > Number(lastMeasurement?.pressure) ? "נמוך" : "גבוה"} (${lastMeasurement?.pressure})`,
        importance: isPressureOutOfRangeVal.howBad
    }

    const isAnActionDay = Number(lastMeasurement.temp) < 9 && (corrected === 1 || corrected === 4 || corrected === 5)
    let dayTxt = ""
    // if (isAnActionDay && corrected !== 1) {
    //     dayTxt += TankCardUse ? `לפי היומן- מיכל ${tankNumber} מתוכנן לרדת שבוע הבא, ` : `לפי היומן- המיכלים הבאים מתוכננים לירידה שבוע הבא: ${nextWeekPack?.join(", ")}. `
    // }
    if (TankCardUse) {
        dayTxt += corrected === 1 ? "מומלץ ביום ראשון לבצע הורדת שמרים ובדיקת גיזוז לכל מיכל קר" :
            corrected === 4 ?
                `לפי היומן- מיכל ${tankNumber} מתוכנן לרדת שבוע הבא, ` +
                "מומלץ ביום רביעי לבצע בדיקת גיזוז לכל מיכל שיורד שבוע הבא. בדוק אם המיכל אכן מתוכנן לרדת" :
                corrected === 5 ?
                    `לפי היומן- מיכל ${tankNumber} מתוכנן לרדת שבוע הבא, ` +
                    "מומלץ ביום חמישי לבצע הורדת שמרים לכל מיכל שיורד שבוע הבא. בדוק אם המיכל אכן מתוכנן לרדת" : ""
    } else {
        dayTxt += corrected === 1 ? "מומלץ ביום ראשון לבצע הורדת שמרים ובדיקת גיזוז לכל המיכלים הקרים" :
            corrected === 4 ?
                `לפי היומן- המיכלים הבאים מתוכננים לירידה שבוע הבא: ${nextWeekPack?.join(", ")}. ` +
                "מומלץ ביום רביעי לבצע בדיקת גיזוז לכל המיכלים שיורדים שבוע הבא. ודא את נכונות נתוני היומן" :
                corrected === 5 ? `לפי היומן- המיכלים הבאים מתוכננים לירידה שבוע הבא: ${nextWeekPack?.join(", ")}. ` +
                    "מומלץ ביום חמישי לבצע הורדת שמרים לכל המיכלים שיורדים שבוע הבא. ודא את נכונות נתוני היומן" : ""

    }


    function calcDisplaySpecifics(): boolean {
        if (!isAnActionDay) {
            return false;
            // dont display any dayli if not sunday/wednesday
        }
        if (corrected === 1) {
            if (carbRes !== null || !YeastDroppedToday) {
                return true
            }
        } else if (tankNumber && nextWeekPack.includes(tankNumber)) {
            if (corrected === 4 && carbRes === null) {
                return true;
            }
            if (corrected === 5 && !YeastDroppedToday) {
                return true;
            }
        }
        return false;

    }

    function formatYeastAmount(amount: number): string {
        if (Number.isInteger(amount)) {
            return String(amount);
        }

        return String(
            Number(amount.toFixed(2))
        );
    }

    // ============================================================
    // YEAST DROP HISTORY
    // ============================================================

    const yeastDrops: YeastDrop[] =
        sortedMeasurements
            .map((measurement) => {

                const note =
                    String(measurement.notes ?? "");

                // חייב להיות קשור לשמרים
                if (
                    !note.includes("שמרים") &&
                    !note.includes("שמרי")
                ) {
                    return null;
                }

                const amount =
                    parseYeastDropAmount(note);

                if (amount === null) {
                    return null;
                }

                const date =
                    getMeasurementDate(measurement.id);

                if (!date) {
                    return null;
                }

                // ------------------------------------------------
                // חם / קר
                //
                // משתמשים בטמפרטורה שנרשמה במדידה.
                // > 9 = חם
                // <= 9 = קר
                // ------------------------------------------------

                const temp =
                    Number(measurement.temp);

                const type: YeastDropType =
                    Number.isFinite(temp) && temp <= 9
                        ? "cold"
                        : "warm";

                return {
                    amount,
                    date,
                    type,
                    note,
                };
            })
            .filter(
                (drop): drop is YeastDrop =>
                    drop !== null
            );

    // ============================================================
    // YEAST DROP COMPLETION RECOMMENDATIONS
    // ============================================================


    /**
     * כל הורדות השמרים אחרי הקירור.
     */
    const coldYeastDrops =
        yeastDrops.filter(
            drop => drop.type === "cold"
        );


    /**
     * כל הורדות השמרים לפני הקירור.
     */
    const warmYeastDrops =
        yeastDrops.filter(
            drop => drop.type === "warm"
        );



    /**
     * ההוצאה הקרה הראשונה אחרי הקירור.
     *
     * חשוב:
     * אנחנו רוצים את הראשונה אחרי מועד הקירור,
     * ולא סתם את הורדת השמרים הקרה האחרונה.
     */
    const firstColdYeastDropAfterCooling =
        CooldDate
            ? coldYeastDrops.find(
                drop => drop.date >= CooldDate
            )
            : undefined;


    /**
     * האם ההוצאה החמה הייתה אתמול?
     */
    const yesterdayWarmYeastDrop =
        warmYeastDrops.find(
            drop =>
                getDaysSinceDate(drop.date) === 1
        );


    /**
     * האם ההוצאה הקרה הראשונה הייתה לפני יומיים?
     */
    const twoDaysAgoColdYeastDrop =
        firstColdYeastDropAfterCooling &&
            getDaysSinceDate(
                firstColdYeastDropAfterCooling.date
            ) === 2
            ? firstColdYeastDropAfterCooling
            : undefined;


    /**
     * יעד להוצאה חמה.
     */
    const warmYeastDropTarget =
        getYeastDropSpec(
            style,
            tankNumber,
            "warm"
        );


    /**
     * יעד להוצאה קרה.
     */
    const coldYeastDropTarget =
        getYeastDropSpec(
            style,
            tankNumber,
            "cold"
        );


    /**
     * המלצה להשלמת הוצאה חמה.
     */
    let requiresWarmYeastDropCompletion = {
        display: false,
        req: false,
        reason: undefined as string | undefined,
        importance: 1,
    };


    /**
     * המלצה להשלמת הוצאה קרה ראשונה.
     */
    let requiresColdYeastDropCompletion = {
        display: false,
        req: false,
        reason: undefined as string | undefined,
        importance: 1,
    };


    // ============================================================
    // WARM YEAST DROP COMPLETION
    // ============================================================

    if (
        yesterdayWarmYeastDrop &&
        warmYeastDropTarget !== null
    ) {

        const missing =
            warmYeastDropTarget -
            yesterdayWarmYeastDrop.amount;

        if (missing > 0) {

            requiresWarmYeastDropCompletion = {
                display: true,
                req: true,
                reason:
                    `בהוצאה חמה אתמול הוצאו ${formatYeastAmount(yesterdayWarmYeastDrop.amount)} דליים. ` +
                    `הכמות המומלצת למיכל זה היא לפחות ${formatYeastAmount(warmYeastDropTarget)} דליים - ` +
                    `מומלץ היום להוציא עוד ${formatYeastAmount(missing)} דליים.`,
                importance: 2,
            };
        }
    }


    // ============================================================
    // COLD YEAST DROP COMPLETION
    // ============================================================

    if (
        twoDaysAgoColdYeastDrop &&
        coldYeastDropTarget !== null
    ) {

        const missing =
            coldYeastDropTarget -
            twoDaysAgoColdYeastDrop.amount;

        if (missing > 0) {

            requiresColdYeastDropCompletion = {
                display: true,
                req: true,
                reason:
                    `בהוצאה קרה לפני יומיים הוצאו ${formatYeastAmount(twoDaysAgoColdYeastDrop.amount)} דליים. ` +
                    `הכמות המומלצת למיכל זה היא לפחות ${formatYeastAmount(coldYeastDropTarget)} דליים - ` +
                    `מומלץ היום להוציא עוד ${formatYeastAmount(missing)} דליים.`,
                importance: 2,
            };
        }
    }

    const displaySpecifics = calcDisplaySpecifics()
    const requiresDailyActions = {
        req: displaySpecifics,
        reason: dayTxt,
        importance: 0
    }

    return {
        requiresDailyActions,
        lastMessurmentUpToDate,
        requiresDryHop,
        requiresPresureClose,
        requiresWarmYeastDrop,
        requiresWarmYeastDropCompletion,
        requiersYeastDropAfterCooling,
        requiresColdYeastDropCompletion,
        requiiersWedYeastDropOnThus,
        requiresCarbTest,
        requiersDiacytelRest,
        neglectedStatus,
        requiresToCoolDown,
        requiredPressureAdjustment
    }
}