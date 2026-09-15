import assert from "node:assert/strict";
import test from "node:test";
import { buildBatchTimeline } from "../src/SERVICES/dashboard/batchTimelineModel";

test("every recorded carbonation test appears on the timeline including zero", () => {
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

test("carbonation-driven pressure adjustment includes result before-pressure and new target", () => {
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
    assert.match(pressure?.detail ?? "", /גיזוז 2.62 vol/);
    assert.match(pressure?.detail ?? "", /לחץ לפני 1.6 bar/);
    assert.match(pressure?.detail ?? "", /לחץ חדש 1.4 bar/);
    assert.match(pressure?.detail ?? "", /פורק ל־1.45 bar/);

    const carbonIndex = events.findIndex((event) => event.type === "carbonation");
    const pressureIndex = events.findIndex((event) => event.type === "pressure");
    assert.ok(carbonIndex >= 0 && pressureIndex > carbonIndex);
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
