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
}

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
    const tolerance = givenSpecs.tolorances.pressure ?? 0.01;
    const onSpec = value >= target + tolerance ||
        value <= target - tolerance;
    let howBad = 0;
    if (onSpec) howBad = 1;
    if (value >= target + 0.1 || value <= target - 0.1) {
        howBad = 3
    } else if (value >= target + tolerance + 0.03 || value <= target - tolerance + 0.03) {
        howBad = 2
    }

    const resault = {
        onSpec,
        howBad
    }
    return resault;
}
export async function calcCelleringRecomendations(measurements: Measurement[], beerStyle: string | number | undefined | null, batchId: string | number | null, brewDate: string, givenSpecs: SpecChart, stage: TankStageInfo) {

    const sortedMeasurements = [...measurements].sort((a, b) => {

        const dateA = String(a.id ?? "");
        const dateB = String(b.id ?? "");

        return dateA.localeCompare(dateB);
    });
    const brewAge = getBrewAge(brewDate);

    // ============================================================
    // GET LATEST MEASUREMENTS
    // ============================================================

    const lastMeasurement: Measurement =
        sortedMeasurements[sortedMeasurements.length - 1];

    const yesterdayMeasurement: Measurement =
        sortedMeasurements[sortedMeasurements.length - 2];

    const toDaysAgoMeasurement: Measurement =
        sortedMeasurements[sortedMeasurements.length - 3];
    if (!lastMeasurement) {
        console.log(
            batchId,
            "No measurements found",
            measurements
        );

        return null
    }
    // ============================================================
    // CHECK IF LAST MEASUREMENT IS FROM TODAY
    // ============================================================




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
        Number(currentPlato) < (givenSpecs.tolorances.yeastDropMinPlato || 6)&&
        pressureIsclosed
    ) {
        const yesterdayPlato =
            Number(yesterdayMeasurement?.plato);

        if (
            Number.isFinite(yesterdayPlato) &&
            Number.isFinite(currentPlato) &&
            yesterdayPlato - currentPlato < 1.5 &&
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
    const requiersYeastDropAfterCooling = {
        display: true,
        req:
            CoolAge === 2 &&
            lastTemp != null &&
            oldTemp != null &&
            lastTemp > oldTemp &&
            stage.name === "קר",
        reason: "(מומלץ לבצע הורדת שמרים- (יומיים אחרי קירור",
        importance: 1
    }

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
    if (CoolAge !== null && CoolAge > 1 && stage.name === "קר") {
        const carbonationSpecToDaysAgo = isCarbonationOutOfRange(toDaysAgoMeasurement?.carbonation, style, givenSpecs)
        if (toDaysAgoMeasurement?.carbonation && !lastMeasurement?.carbonation) {
            if (carbonationSpecToDaysAgo?.outOfSpec) {
                requiresCarbTest.display = true,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה ההאחרונה לא תקין(${toDaysAgoMeasurement?.carbonation})- מומלץ לבצע בדיקת גיזוז חוזרת ` :
                    `הגיזוז לפני יומיים לא תקין(${toDaysAgoMeasurement?.carbonation})- מומלץ לבצע בדיקת גיזוז חוזרת `
                requiresCarbTest.importance = carbonationSpecToDaysAgo?.importance
            } else {
                requiresCarbTest.display = false,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה ההאחרונה תקין(${toDaysAgoMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת` :
                    `הגיזוז לפני יומיים תקין(${toDaysAgoMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת`
                requiresCarbTest.importance = carbonationSpecToDaysAgo?.importance
            }
        }
        const CarbonationSpecYesterday = isCarbonationOutOfRange(yesterdayMeasurement?.carbonation, style, givenSpecs)
        if (yesterdayMeasurement?.carbonation && !lastMeasurement?.carbonation) {
            if (CarbonationSpecYesterday.outOfSpec) {
                requiresCarbTest.display = true,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה האחרונה היה לא תקין(${yesterdayMeasurement?.carbonation})- מומלץ לבצע בדיקת גיזוז חוזרת ` :
                    `הגיזוז אתמול היה לא תקין(${yesterdayMeasurement?.carbonation})- מומלץ לבצע מחר בדיקת גיזוז חוזרת `,
                    requiresCarbTest.importance = CarbonationSpecYesterday.importance
            } else {
                requiresCarbTest.display = false,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה האחרונה היה תקין(${yesterdayMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת` :
                    `הגיזוז אתמול היה תקין(${yesterdayMeasurement?.carbonation})- ניתן להמתין עם בדיקת גיזוז נוספת`

            }
        }
        const carbonationSpecToDay = isCarbonationOutOfRange(lastMeasurement?.carbonation, style, givenSpecs)
        if (lastMeasurement?.carbonation) {
            if (carbonationSpecToDay.outOfSpec) {
                requiresCarbTest.display = true,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה ההאחרונה לא תקין(${lastMeasurement?.carbonation})- מומלץ לבצע שינוי לחץ בהתאם, או לוודא שבוצע שינוי לחץ ` :
                    `הגיזוז היום לא תקין(${lastMeasurement?.carbonation})- מומלץ לבצע שינוי לחץ בהתאם, או לוודא שבוצע שינוי לחץ `
                requiresCarbTest.importance = carbonationSpecToDay.importance
            } else {
                requiresCarbTest.display = false,
                    requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז בבדיקה האחרונה תקין(${lastMeasurement?.carbonation})-ניתן להמתין עם בדיקת גיזוז נוספת ` :
                    `הגיזוז היום תקין(${lastMeasurement?.carbonation})-ניתן להמתין עם בדיקת גיזוז נוספת `
                requiresCarbTest.importance = carbonationSpecToDay.importance
            }
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
    const normalizedStyle = String(style || "").trim().toLowerCase();
    const isLager = normalizedStyle.includes("לאגר");
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
            if (Number(lastMeasurement.temp) > 9) { readyToCoolDownText= "לפי הרישום המיכל כבר קורר- במדידת טמפ' זה יעודכן, מומלץ לוודא" }
            else coolDownDisplay = false
        } else {
            if (Number(lastMeasurement.temp) > 9) readyToCoolDownText= "המיכל מוכן לקירור. מומלץ לכוון טמפ' לקירור ולשנוק את ברזי` הגליקול";
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
    const requiredPressureAdjustment = {
        display: true,
        req: stage.name === "בתסיסה" && Number(lastMeasurement?.pressure) > 0 && Number(lastMeasurement?.temp) > 9 && isPressureOutOfRangeVal.onSpec,
        reason: `מומלץ לכוון פורק ל ${pressureSpecs[normalizedStyle]}, הלחץ כרגע ${pressureSpecs[normalizedStyle] > Number(lastMeasurement?.pressure) ? "נמוך" : "גבוה"} (${lastMeasurement?.pressure})`,
        importance: isPressureOutOfRangeVal.howBad
    }
    const today = new Date().getDay();
    const corrected = today === 0 ? 1 : today + 1;
    const requiresDailyActions = {
        req: Number(lastMeasurement.temp) < 9 && (corrected === 1 || corrected === 4 || corrected === 5),
        reason:
            corrected === 1 ? "מומלץ ביום ראשון לבצע הורדת שמרים ובדיקת גיזוז לכל מיכל קר" :
                corrected === 4 ? "מומלץ ביום רביעי לבצע בדיקת גיזוז לכל מיכל שיורד שבוע הבא. בדוק אם המיכל מתוכנן לרדת" :
                    corrected === 5 ? "מומלץ ביום חמישי לבצע הורדת שמרים לכל מיכל שיורד שבוע הבא. בדוק אם המיכל מתוכנן לרדת" : "",
        importance: 0
    }

    return {
        requiresDailyActions, lastMessurmentUpToDate, requiresDryHop, requiresPresureClose,
        requiresWarmYeastDrop, requiersYeastDropAfterCooling, requiresCarbTest, requiersDiacytelRest,
        neglectedStatus, requiresToCoolDown, requiredPressureAdjustment
    }
}