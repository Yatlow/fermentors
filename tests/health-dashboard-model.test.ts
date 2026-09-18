import assert from "node:assert/strict";
import test from "node:test";
import {
    calculateCellarHealthScore,
    dailyMeasurementProgress,
    healthBand,
    isActionableHealthRecommendation,
    missingDailyMeasurementFields,
} from "../src/SERVICES/dashboard/healthModel";

const TODAY = new Date(2026, 8, 15, 12, 0, 0);

test("pressure zero is a valid daily pressure measurement", () => {
    const missing = missingDailyMeasurementFields([
        {
            id: "2026-09-15_0800",
            temp: 18.2,
            pressure: 0,
        },
    ], false, TODAY);

    assert.deepEqual(missing, []);
});

test("note-only rows do not complete the daily measurement round", () => {
    const progress = dailyMeasurementProgress([
        {
            id: "2026-09-15_0815",
            temp: null,
            pressure: null,
            plato: null,
            pH: null,
            notes: "בדיקת smoke כללית",
        },
    ], true, TODAY);

    assert.deepEqual(progress.missingFields, ["temp", "pressure", "plato", "pH"]);
    assert.equal(progress.completedFieldCount, 0);
    assert.equal(progress.requiredFieldCount, 4);
});

test("blank and non-finite values do not count as measurements", () => {
    const missing = missingDailyMeasurementFields([
        {
            id: "2026-09-15_0815",
            temp: "   ",
            pressure: Number.NaN,
        },
    ], false, TODAY);

    assert.deepEqual(missing, ["temp", "pressure"]);
});

test("Sheet placeholder dashes do not count as measurements", () => {
    const missing = missingDailyMeasurementFields([
        {
            id: "2026-09-15_0815",
            temp: "—",
            pressure: "-",
            notes: "הערה בלבד",
        },
    ], false, TODAY);

    assert.deepEqual(missing, ["temp", "pressure"]);
});

test("numeric Sheet strings still count and pressure zero remains valid", () => {
    const missing = missingDailyMeasurementFields([
        {
            id: "2026-09-15_0815",
            temp: "18.4°C",
            pressure: "0 bar",
        },
    ], false, TODAY);

    assert.deepEqual(missing, []);
});

test("hot tanks require temperature pressure plato and pH", () => {
    const missing = missingDailyMeasurementFields([
        {
            id: "2026-09-15_0800",
            temp: 18.2,
            pressure: 0,
            plato: 5.8,
        },
    ], true, TODAY);

    assert.deepEqual(missing, ["pH"]);
});

test("daily completeness can be satisfied across multiple rows from today", () => {
    const progress = dailyMeasurementProgress([
        { id: "2026-09-15_0730", temp: 17.8, pressure: 0 },
        { id: "2026-09-15_0915", plato: 6.2, pH: 4.25 },
    ], true, TODAY);

    assert.deepEqual(progress.missingFields, []);
    assert.equal(progress.completedFieldCount, 4);
});

test("yesterday values do not satisfy today's round", () => {
    const missing = missingDailyMeasurementFields([
        { id: "2026-09-14_1800", temp: 18, pressure: 1.2, plato: 6, pH: 4.2 },
    ], true, TODAY);

    assert.deepEqual(missing, ["temp", "pressure", "plato", "pH"]);
});

test("future recommendation hints do not count as today's health work", () => {
    assert.equal(isActionableHealthRecommendation({ req: true, display: false }), false);
    assert.equal(isActionableHealthRecommendation({ req: true, display: true }), true);
    assert.equal(isActionableHealthRecommendation({ req: false, display: true }), false);
});

test("pH-only hot round earns exactly one quarter measurement credit and remains incomplete", () => {
    const progress = dailyMeasurementProgress([
        { id: "2026-09-15_0815", pH: 4.31 },
    ], true, TODAY);

    assert.deepEqual(progress.missingFields, ["temp", "pressure", "plato"]);
    assert.equal(progress.completedFieldCount, 1);
    assert.equal(progress.requiredFieldCount, 4);
    assert.equal(calculateCellarHealthScore([], [progress]), 25);
});

test("complete measurement rounds score 100 when there are no actionable recommendations", () => {
    const score = calculateCellarHealthScore([], [
        { missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 },
        { missingFields: [], requiredFieldCount: 4, completedFieldCount: 4 },
    ]);

    assert.equal(score, 100);
});

test("grace measurements add earned credit without adding any requirement", () => {
    const withoutGraceBonus = calculateCellarHealthScore(
        [{ importance: 3 }],
        [{ missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 }],
    );
    const withGraceBonus = calculateCellarHealthScore(
        [{ importance: 3 }],
        [
            { missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 },
            {
                missingFields: [],
                requiredFieldCount: 0,
                completedFieldCount: 0,
                bonusCompletedFieldCount: 1,
            },
        ],
    );

    assert.equal(withoutGraceBonus, 22);
    assert.equal(withGraceBonus, 33);
});

test("grace measurements alone cannot push the score above 100", () => {
    const score = calculateCellarHealthScore([], [
        {
            missingFields: [],
            requiredFieldCount: 0,
            completedFieldCount: 0,
            bonusCompletedFieldCount: 4,
        },
    ]);

    assert.equal(score, 100);
});

test("actionable recommendations reduce the index until they disappear", () => {
    const score = calculateCellarHealthScore(
        [{ importance: 3 }, { importance: 1 }],
        [{ missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 }]
    );

    assert.equal(score, 18);
    assert.equal(healthBand(score), "critical");
    assert.equal(healthBand(95), "healthy");
    assert.equal(healthBand(75), "warning");
});

test("zero completed work stays at zero even with many recommendations", () => {
    const score = calculateCellarHealthScore(
        Array.from({ length: 20 }, () => ({ importance: 3 })),
        [{
            missingFields: ["temp", "pressure"],
            requiredFieldCount: 2,
            completedFieldCount: 0,
        }]
    );

    assert.equal(score, 0);
});


test("completed cellar actions add earned action credit", () => {
    const score = calculateCellarHealthScore(
        [{ importance: 3 }],
        [{ missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 }],
        [{ importance: 3 }],
    );

    assert.equal(score, 56);
});

test("completed high-importance action can fully replace an equal unresolved action once handled", () => {
    const before = calculateCellarHealthScore(
        [{ importance: 3 }],
        [{ missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 }],
    );
    const after = calculateCellarHealthScore(
        [],
        [{ missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 }],
        [{ importance: 3 }],
    );

    assert.equal(before, 22);
    assert.equal(after, 100);
});
