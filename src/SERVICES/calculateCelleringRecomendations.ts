import { getBrewAge } from "../components/TankCard";

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
    style: string
): { outOfSpec: boolean, importance: number } {

    const specs: Record<string, number> = {
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
    const tolerance = 0.04;
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
    style: string | null
): { onSpec: boolean, howBad: number } {
    const pressureSpecs: Record<string, number> = {
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
    const tolerance = 0.01;
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
export function calcCelleringRecomendations(measurements: Measurement[], beerStyle: string | number | undefined | null, batchId: string | number | null, brewDate: string) {
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

        req:
            !!lastMeasurementDate &&
            lastMeasurementDate !== todayDate,

        reason:
            lastMeasurementDate &&
                lastMeasurementDate !== todayDate
                ? `שים לב - המדידה האחרונה היא מתאריך ${lastMeasurementDate} ולא מהיום. ההמלצות הן בהתאם למדידה האחרונה. מומלץ לבצע סבב מדידות יומי בטרם בדיקת המלצות.`
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
                ).includes("הורדת")
        ) || measurements.some(
            measurement =>
                String(
                    measurement.notes || ""
                ).includes("שמרים"));

    const requiresDryHop = {
        req: isHoppy &&
            Number(lastMeasurement?.plato) < 8 &&
            Number(lastMeasurement?.temp) > 9 &&
            Number(lastMeasurement?.pressure) <= 0 &&
            !dryhopped,
        reason: "מומלץ לבצע דריי-הופ",
        importance: 1
    }

    const requiresPresureClose = {
        req: !isHoppy &&
            Number(lastMeasurement?.plato) < 5 &&
            Number(lastMeasurement?.temp) > 9 &&
            Number(lastMeasurement?.pressure) <= 0,
        reason: "מומלץ לבצע סגירת לחץ",
        importance: 1
    }


    const currentPlato = Number(lastMeasurement?.plato);

    const dryHopAge =
        dryHopDate !== null
            ? getDaysSinceDate(dryHopDate)
            : null;

    let requiresWarmYeastDrop = {
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
        !requiresDryHop.req
    ) {

        requiresWarmYeastDrop = {
            req: true,
            reason: "מומלצת הוצאת שמרים- 5 ימים אחרי דרי הופ",
            importance: 1
        };
    }


    else if (
        isHoppy &&
        dryHopAge !== null &&
        dryHopAge < 5 &&
        dryhopped &&
        !yeastDroppedOnce &&
        !requiresDryHop.req
    ) {

        requiresWarmYeastDrop = {
            req: true,
            reason:
                `מומלצת הורדת שמרים בעוד ${5 - dryHopAge} ימים- אחרי דרייהופ`,
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
        yesterdayMeasurement
    ) {

        const yesterdayPlato =
            Number(yesterdayMeasurement?.plato);


        if (
            Number.isFinite(yesterdayPlato) &&
            Number.isFinite(currentPlato) &&
            yesterdayPlato - currentPlato < 1.5
        ) {
            requiresWarmYeastDrop = {
                req: true,
                reason: lastMessurmentUpToDate.req ?
                    `מומלצת הורדת שמרים - הסוכר במדידה אחרונה ${currentPlato}P°, במדידה קודמת ${yesterdayPlato}P°` :
                    `מומלצת הורדת שמרים - הסוכר היום ${currentPlato}P°, אתמול ${yesterdayPlato}P°`,
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
        req:
            CoolAge === 2 &&
            lastTemp != null &&
            oldTemp != null &&
            lastTemp > oldTemp,
        reason: "(מומלצת הורדת שמרים- (יומיים אחרי קירור",
        importance: 1
    }

    let requiresCarbTest = {
        req: false,
        reason: undefined as string | undefined,
        importance: 1
    };

    if (
        CoolAge === 1 &&
        yesterdayMeasurement?.temp != null &&
        lastMeasurement?.temp != null &&
        yesterdayMeasurement.temp > lastMeasurement.temp &&
        !lastMeasurement?.carbonation
    ) {
        requiresCarbTest.req = true;
        requiresCarbTest.reason = "מומלץ גיזוז- (יום אחרי קירור)",
            requiresCarbTest.importance = 1;
    }

    if (CoolAge !== null && CoolAge > 1) {
        const CarbonationSpecYesterday = isCarbonationOutOfRange(yesterdayMeasurement?.carbonation, style)
        if (yesterdayMeasurement?.carbonation && !lastMeasurement?.carbonation) {
            if (CarbonationSpecYesterday.outOfSpec) {
                requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז במדידה אחרונה היה לא תקין(${yesterdayMeasurement?.carbonation})- מומלץ לבצע גיזוז חוזר ` :
                    `הגיזוז אתמול היה לא תקין(${yesterdayMeasurement?.carbonation})- מומלץ לבצע מחר גיזוז חוזר `,
                    requiresCarbTest.importance = CarbonationSpecYesterday.importance
            } else {
                requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז במדידה אחרונה היה תקין(${yesterdayMeasurement?.carbonation})- ניתן להמתין עם בדיקה נוספת` :
                    `הגיזוז אתמול היה תקין(${yesterdayMeasurement?.carbonation})- ניתן להמתין עם בדיקה נוספת`

            }
        }
        const carbonationSpecToDaysAgo = isCarbonationOutOfRange(toDaysAgoMeasurement?.carbonation, style)
        if (toDaysAgoMeasurement?.carbonation && !lastMeasurement?.carbonation) {
            if (carbonationSpecToDaysAgo?.outOfSpec) {
                requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז במדידה שלפני האחרונה לא תקין(${toDaysAgoMeasurement?.carbonation})- מומלץ לבצע גיזוז חוזר ` :
                    `הגיזוז לפני יומיים לא תקין(${toDaysAgoMeasurement?.carbonation})- מומלץ לבצע גיזוז חוזר `
                requiresCarbTest.importance = carbonationSpecToDaysAgo?.importance
            } else {
                requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז במדידה שלפני האחרונה תקין(${toDaysAgoMeasurement?.carbonation})- ניתן להמתין עם בדיקה נוספת` :
                    `הגיזוז לפני יומיים תקין(${toDaysAgoMeasurement?.carbonation})- ניתן להמתין עם בדיקה נוספת`
                requiresCarbTest.importance = carbonationSpecToDaysAgo?.importance
            }
        }
        const carbonationSpecToDay = isCarbonationOutOfRange(lastMeasurement?.carbonation, style)
        if (lastMeasurement?.carbonation) {
            if (carbonationSpecToDay.outOfSpec) {
                requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז במדידה האחרונה לא תקין(${lastMeasurement?.carbonation})- מומלץ לבצע שינוי לחץ בהתאם ` :
                    `הגיזוז היום לא תקין(${lastMeasurement?.carbonation})- מומלץ לבצע שינוי לחץ בהתאם `
                requiresCarbTest.importance = carbonationSpecToDay.importance
            } else {
                requiresCarbTest.req = true;
                requiresCarbTest.reason = lastMessurmentUpToDate.req ?
                    `הגיזוז במדידה אחרונה תקין(${lastMeasurement?.carbonation})-ניתן להמתין עם בדיקה נוספת ` :
                    `הגיזוז היום תקין(${lastMeasurement?.carbonation})-ניתן להמתין עם בדיקה נוספת `
                requiresCarbTest.importance = carbonationSpecToDay.importance
            }
        }
        // ============================================================
        // LAST INVALID CARBONATION - NO TEST FOR MORE THAN 2 DAYS
        // ============================================================

        if (!requiresCarbTest.req) {
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
                        style
                    );

                if (
                    carbonationAge !== null &&
                    carbonationAge > 2 &&
                    lastCarbonationSpec.outOfSpec
                ) {
                    requiresCarbTest.req = true;

                    requiresCarbTest.reason =
                        `הגיזוז האחרון לא תקין (${lastCarbonationMeasurement.carbonation})- לא נמדד יותר מיומיים, מומלץ לבצע בדיקת גיזוז`;

                    requiresCarbTest.importance =
                        lastCarbonationSpec.importance;
                }
            }
        }
    }

    const normalizedStyle = String(style || "").trim().toLowerCase();
    const isLager = normalizedStyle.includes("לאגר");
    const requiersDiacytelRest = {
        req: isLager && Number(lastMeasurement?.plato) < 9 && Number(lastMeasurement?.temp) > 9 && Number(lastMeasurement?.temp) < 13 &&
            !measurements.some(
                measurement =>
                    String(
                        measurement.notes || ""
                    ).includes("דיאציטיל") &&
                    !measurements.some(
                        measurement =>
                            String(
                                measurement.notes || ""
                            ).includes("מנוח")
                    )
            ),
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
        if (CoolAge === null) {
            return {
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
        Number(yesterdayMeasurement?.plato) >= Number(lastMeasurement?.plato) &&
        !CooldDate
    )


    const requiresToCoolDown = {
        req: !CooldDate,
        reason: !readyToCoolDown ? "עוד לא מוכן לקירור -עדיין לא הסתיימה התסיסה" : yeastDroppedOnce ? "המיכל מוכן לקירור!" : "המיכל סיים לתסוס, מומלץ להוריד שמרים לפני קירור",
        importance: !readyToCoolDown ? 0 : 1,
    }

    const pressureSpecs: Record<string, number> = {
        ipa: 1.6,
        פייל: 1.7,
        לאגר: 1.1,
        הופי: 1.1,
        חיטה: 1.6,
        סטאוט: 1.5,
        other: 1.5
    };


    const isPressureOutOfRangeVal = isPressureOutOfRange(lastMeasurement?.pressure, style)
    const requiredPressureAdjustment = {
        req: Number(lastMeasurement?.pressure) > 0 && Number(lastMeasurement?.temp) > 9 && isPressureOutOfRangeVal.onSpec,
        reason: `מומלץ לכוון פורק ל ${pressureSpecs[normalizedStyle]}, הלחץ כרגע ${pressureSpecs[normalizedStyle] > Number(lastMeasurement?.pressure) ? "נמוך" : "גבוה"} (${lastMeasurement?.pressure})`,
        importance: isPressureOutOfRangeVal.howBad
    }

    return { lastMessurmentUpToDate, requiresDryHop, requiresPresureClose, requiresWarmYeastDrop, requiersYeastDropAfterCooling, requiresCarbTest, requiersDiacytelRest, neglectedStatus, requiresToCoolDown, requiredPressureAdjustment }
}