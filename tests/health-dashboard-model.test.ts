import assert from "node:assert/strict";
import test from "node:test";
import {
    calculateCellarHealthScore,
    healthBand,
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
    const missing = missingDailyMeasurementFields([
        { id: "2026-09-15_0730", temp: 17.8, pressure: 0 },
        { id: "2026-09-15_0915", plato: 6.2, pH: 4.25, notes: "פעולה" },
    ], true, TODAY);

    assert.deepEqual(missing, []);
});

test("yesterday values do not satisfy today's round", () => {
    const missing = missingDailyMeasurementFields([
        { id: "2026-09-14_1800", temp: 18, pressure: 1.2, plato: 6, pH: 4.2 },
    ], true, TODAY);

    assert.deepEqual(missing, ["temp", "pressure", "plato", "pH"]);
});

test("health score weights live recommendations more heavily than routine measurement gaps", () => {
    const score = calculateCellarHealthScore(
        [{ importance: 3 }, { importance: 1 }],
        [{ missingFields: ["temp", "pressure"] }]
    );

    assert.equal(score, 75);
    assert.equal(healthBand(score), "warning");
    assert.equal(healthBand(95), "healthy");
    assert.equal(healthBand(40), "critical");
});

test("health score is clamped at zero", () => {
    const score = calculateCellarHealthScore(
        Array.from({ length: 20 }, () => ({ importance: 3 })),
        []
    );

    assert.equal(score, 0);
});
