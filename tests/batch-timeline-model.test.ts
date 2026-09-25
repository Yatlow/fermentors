import assert from "node:assert/strict";
import test from "node:test";
import { buildBatchTimeline } from "../src/SERVICES/dashboard/batchTimelineModel";
import { expandCompoundCellarMeasurements } from "../src/SERVICES/cellering/bottomCarbonation";

test("every standalone recorded carbonation test appears on the timeline including zero", () => {
    const events = buildBatchTimeline([
        { id: "2026-09-10_0800", carbonation: 2.1 },
        { id: "2026-09-11_0800", carbonation: 2.3 },
        { id: "2026-09-12_0800", carbonation: 0 },
    ], "09/09/2026");

    const carbonation = events.filter((event) => event.type === "carbonation");
    assert.equal(carbonation.length, 3);
    assert.deepEqual(carbonation.map((event) => event.detail), [
        "תוצאה 2.1 vol",
        "תוצאה 2.3 vol",
        "תוצאה 0 vol",
    ]);
});

test("dry hop and pressure closure are shown as one combined event", () => {
    const events = buildBatchTimeline([
        {
            id: "2026-09-11_1000",
            notes: "הכנסת כשות 4. דרייהופ. 5000 גרם של Citra. סגירת לחץ, כיוון פורק ל1.6 bar",
        },
    ], "09/09/2026");

    const dryHop = events.find((event) => event.type === "dryhop");
    assert.equal(dryHop?.label, "דרייהופ + סגירת לחץ");
    assert.match(dryHop?.detail ?? "", /5000 גרם Citra/);
    assert.match(dryHop?.detail ?? "", /פורק ל־1.6 bar/);
    assert.equal(events.filter((event) => event.type === "pressure").length, 0);
});

test("yeast drop shows parsed bucket quantity", () => {
    const events = buildBatchTimeline([
        {
            id: "2026-09-12_0800",
            notes: "הורדת שבעה וחצי דליי שמרים, לחץ אחרי 1.1 bar",
        },
    ], "09/09/2026", () => 7.5);

    const yeast = events.find((event) => event.type === "yeast");
    assert.equal(yeast?.label, "הורדת שמרים");
    assert.match(yeast?.detail ?? "", /7.5 דליים/);
    assert.match(yeast?.detail ?? "", /לחץ אחרי 1.1 bar/);
});

test("carbonation-driven pressure adjustment includes the test once and separates pressure details by lines", () => {
    const events = buildBatchTimeline([
        {
            id: "2026-09-13_0900",
            carbonation: 2.62,
            pressure: 1.6,
            notes: "הורדת לחץ ל: 1.4 bar | כיוון פורק ל: 1.45 bar",
        },
    ], "09/09/2026");

    const pressure = events.find((event) => event.type === "pressure");
    assert.equal(pressure?.label, "שינוי לחץ בעקבות גיזוז");
    assert.equal(pressure?.detail, [
        "גיזוז: 2.62 vol",
        "לחץ לפני: 1.6 bar",
        "לחץ חדש: 1.4 bar",
        "פורק: 1.45 bar",
    ].join("\n"));
    assert.equal(events.filter((event) => event.type === "carbonation").length, 0);
});

test("pressure change after cooling consumes the prior separate carbonation test", () => {
    const events = buildBatchTimeline([
        { id: "2026-09-12_0800", notes: "קירור מיכל ל0.3°", pressure: 1.5 },
        { id: "2026-09-13_0800", carbonation: 2.68, pressure: 1.5 },
        { id: "2026-09-13_1000", notes: "הורדת לחץ ל: 1.3 bar", pressure: 1.5 },
    ], "09/09/2026");

    const pressure = events.find((event) => event.type === "pressure");
    assert.equal(pressure?.label, "שינוי לחץ בעקבות גיזוז");
    assert.match(pressure?.detail ?? "", /גיזוז: 2.68 vol/);
    assert.match(pressure?.detail ?? "", /לחץ לפני: 1.5 bar/);
    assert.match(pressure?.detail ?? "", /לחץ חדש: 1.3 bar/);
    assert.equal(events.filter((event) => event.type === "carbonation").length, 0);
});

test("a different standalone carbonation test remains visible after one test is consumed by a correction", () => {
    const events = buildBatchTimeline([
        { id: "2026-09-12_0800", notes: "קירור מיכל ל0.3°", pressure: 1.5 },
        { id: "2026-09-13_0700", carbonation: 2.52, pressure: 1.5 },
        { id: "2026-09-13_0800", carbonation: 2.68, pressure: 1.5 },
        { id: "2026-09-13_1000", notes: "הורדת לחץ ל: 1.3 bar", pressure: 1.5 },
    ], "09/09/2026");

    const carbonation = events.filter((event) => event.type === "carbonation");
    assert.equal(carbonation.length, 1);
    assert.equal(carbonation[0]?.detail, "תוצאה 2.52 vol");
});

test("ordinary pressure and relief-valve adjustment is distinct from closure", () => {
    const events = buildBatchTimeline([
        {
            id: "2026-09-12_0900",
            pressure: 1.2,
            notes: "העלאת לחץ ל: 1.4 bar | כיוון פורק ל: 1.5 bar",
        },
        {
            id: "2026-09-13_0900",
            notes: "סגירת נשם, כיוון פורק ל 1.6",
        },
    ], "09/09/2026");

    const pressureEvents = events.filter((event) => event.type === "pressure");
    assert.equal(pressureEvents[0]?.label, "שינוי לחץ וכיוון פורק");
    assert.equal(pressureEvents[1]?.label, "סגירת לחץ");
});

test("diacetyl rest uses a hot-water/heating icon instead of fire", () => {
    const events = buildBatchTimeline([
        {
            id: "2026-09-14_0800",
            notes: "חימום מיכל ל14° למנוחת דיאציטיל",
        },
    ], "09/09/2026");

    const diacetyl = events.find((event) => event.type === "diacetyl");
    assert.equal(diacetyl?.icon, "♨️");
});


test("bottom-carbonation start close and final pressure stay one operational timeline action", () => {
    const expanded = expandCompoundCellarMeasurements([
        {
            id: "2026-09-18_0910",
            pressure: 1.33,
            notes: "הורדת 1.5 דליי שמרים, לחץ אחרי 1.33 bar | הורדת לחץ ל0. פתיחת כוסית מים של הפורק לחץ, ניקוי והחזרה עם מים חדשים. העלאת לחץ ל0.2. תחילת גיזוז מלמטה בשעה 9:10 | סגירת גיזוז מלמטה בשעה 14:40 על 0.43bar | העלאת לחץ ל: 1.4 bar",
        },
    ]);

    assert.equal(expanded.length, 2);
    assert.match(String(expanded[1]?.notes ?? ""), /תחילת גיזוז מלמטה/);
    assert.match(String(expanded[1]?.notes ?? ""), /סגירת גיזוז מלמטה/);
    assert.match(String(expanded[1]?.notes ?? ""), /העלאת לחץ ל: 1.4/);

    const events = buildBatchTimeline(expanded, "10/09/2026", () => 1.5);
    assert.equal(events.filter((event) => event.type === "yeast").length, 1);
    assert.equal(events.filter((event) => event.type === "pressure").length, 1);
});


test("consecutive duplicate action notes are collapsed before timeline rendering", () => {
    const expanded = expandCompoundCellarMeasurements([
        {
            id: "2026-09-22_0725",
            pressure: 0.91,
            carbonation: 2.38,
            notes: "העלאת לחץ ל: 1.2 bar | העלאת לחץ ל: 1.2 bar",
        },
    ]);

    assert.equal(expanded.length, 1);
    assert.equal(expanded[0]?.notes, "העלאת לחץ ל: 1.2 bar");

    const events = buildBatchTimeline(expanded, "07/09/2026");
    const pressureEvents = events.filter((event) => event.type === "pressure");
    assert.equal(pressureEvents.length, 1);
    assert.equal(pressureEvents[0]?.label, "שינוי לחץ בעקבות גיזוז");
});


test("bottom carbonation row keeps the carb test separate from the bottom-carbonation action", () => {
    const expanded = expandCompoundCellarMeasurements([
        {
            id: "2026-09-23_0554",
            temp: 0.7,
            pressure: 1.3,
            carbonation: 2.26,
            notes: "הורדת לחץ ל0.2 bar. תחילת גיזוז מלמטה בשעה 10:22 | סגירת גיזוז מלמטה בשעה 20:33 על 1.3 bar.",
        },
    ]);

    assert.equal(expanded.length, 1);

    const events = buildBatchTimeline(expanded, "09/09/2026");
    const carbonation = events.find((event) => event.type === "carbonation");
    const pressure = events.find((event) => event.type === "pressure");

    assert.equal(carbonation?.label, "בדיקת גיזוז");
    assert.equal(carbonation?.detail, "תוצאה 2.26 vol");
    assert.equal(carbonation?.note, undefined, "bottom-carbonation note must not reclassify the carb-test bubble");
    assert.ok(pressure, "the bottom-carbonation action must still produce its action event");
    assert.match(String(pressure?.note ?? ""), /תחילת גיזוז מלמטה/);
    assert.match(String(pressure?.note ?? ""), /סגירת גיזוז מלמטה/);
});
