import test from "node:test";
import assert from "node:assert/strict";
import {
    hasCellarActionOnDate,
    completedCarbonationPressureAdjustmentOnDate,
    carbonationPressureAdjustmentEvidenceOnDate,
} from "../src/SERVICES/cellering/cellarActionState";

test("cellar action remains completed when a later same-day row has another note", () => {
    const rows = [
        { id: "2026-09-27_0915", notes: "כיוון פורק ל-1.4" },
        { id: "2026-09-27_1330", notes: "בדיקת גיזוז 2.45" },
    ];

    assert.equal(hasCellarActionOnDate(rows, "2026-09-27", ["כיוון פורק", "לכוון פורק"]), true);
});

test("cellar action completion never leaks from another day", () => {
    const rows = [
        { id: "2026-09-26_1745", notes: "כיוון פורק" },
        { id: "2026-09-27_0810", notes: "טמפ ולחץ" },
    ];

    assert.equal(hasCellarActionOnDate(rows, "2026-09-27", ["כיוון פורק", "לכוון פורק"]), false);
});

test("historical unpadded measurement times are still recognized", () => {
    assert.equal(
        hasCellarActionOnDate(
            [{ id: "2026-09-27_917", notes: "הורדת לחץ ל-0.7" }],
            "2026-09-27",
            ["הורדת לחץ", "העלאת לחץ"],
        ),
        true,
    );
});

const inRange = (value: number) => Math.abs(value - 2.45) < 0.04;

test("tank 13: same-row real pressure decrease completes today's correction, even without older carbonation", () => {
    const history = [
        { id: "2026-11-18_0622", carbonation: 2.53, pressure: 1.5,
            notes: "הורדת לחץ ל: 0.1 bar" },
    ];
    const evidence = carbonationPressureAdjustmentEvidenceOnDate(history, "2026-11-18", inRange);
    assert.deepEqual(evidence, { carbonation: 2.53, firstInRange: false });
    assert.equal(completedCarbonationPressureAdjustmentOnDate(history, "2026-11-18"), 2.53);
    assert.equal(completedCarbonationPressureAdjustmentOnDate(history, "2026-11-17"), null);
});

test("tank 9: pressure lowered after FIRST in-range 2.44, not prior invalid 2.36", () => {
    const history = [
        { id: "2026-11-16_0830", carbonation: 2.36, pressure: 1.48, notes: "" },
        { id: "2026-11-18_0622", carbonation: 2.44, pressure: 1.01,
            notes: "הורדת לחץ ל: 0.8 bar" },
    ];
    assert.deepEqual(carbonationPressureAdjustmentEvidenceOnDate(
        history, "2026-11-18", inRange,
    ), { carbonation: 2.44, firstInRange: true });
    assert.equal(completedCarbonationPressureAdjustmentOnDate(history, "2026-11-18"), 2.44);
});

test("latest action/test wins, and a later unrelated measurement does not reopen completed work", () => {
    const history = [
        { id: "2026-11-18_1500", temp: 1.2, notes: "שמרים" },
        { id: "2026-11-18_1245", carbonation: 2.45, notes: "הורדת לחץ ל: 0.7 bar" },
        { id: "2026-11-17_0830", carbonation: 2.31 },
        { id: "2026-11-18_0730", carbonation: 2.33, notes: "העלאת לחץ ל: 1.6 bar" },
    ];
    assert.deepEqual(carbonationPressureAdjustmentEvidenceOnDate(
        history, "2026-11-18", inRange,
    ), { carbonation: 2.45, firstInRange: true });
});

test("separate actual action after today's test is matched; packaging never completes cellaring pressure", () => {
    const history = [
        { id: "2026-11-17_0900", carbonation: 2.32 },
        { id: "2026-11-18_0800", carbonation: 2.44 },
        { id: "2026-11-18_1100", notes: "הורדת לחץ ל: 0.8 bar" },
    ];
    assert.deepEqual(carbonationPressureAdjustmentEvidenceOnDate(
        history, "2026-11-18", inRange,
    ), { carbonation: 2.44, firstInRange: true });
    assert.deepEqual(carbonationPressureAdjustmentEvidenceOnDate(
        [history[0], history[1], { id: "2026-11-18_1100", notes: "הורדת 40 בקבוקים | הורדת לחץ ל: 0.8 bar" }],
        "2026-11-18", inRange,
    ), null);
});

test("later valid carbonation following an already-valid test is not a second first-hit event", () => {
    const history = [
        { id: "2026-11-17_0800", carbonation: 2.44 },
        { id: "2026-11-18_0800", carbonation: 2.45, notes: "הורדת לחץ ל: 0.8 bar" },
    ];
    assert.deepEqual(carbonationPressureAdjustmentEvidenceOnDate(
        history, "2026-11-18", inRange,
    ), { carbonation: 2.45, firstInRange: false });
});
