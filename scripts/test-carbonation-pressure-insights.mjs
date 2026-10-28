import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const transpiled = ts.transpileModule(read("../src/SERVICES/cellering/carbonationPressureInsights.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { latestPressureReading, carbonationPressureContext, firstInRangePressureAdvice } =
    await import("data:text/javascript;base64," + Buffer.from(transpiled).toString("base64"));

const today = "2026-10-28";
const inRange = (value) => Math.abs(value - 2.45) < 0.03;
const carb = (id, carbonation, pressure) => ({ id, carbonation, pressure });

test("last pressure is taken independently of the latest carbonation reading", () => {
    const history = [
        carb("2026-10-28_1045", "2.10"),
        { id: "2026-10-27_0940", pressure: "1,25" },
        { id: "2026-10-28_0710", pressure: "1.4" },
        { id: "2026-10-27_1755", pressure: "1.7" },
    ];
    assert.deepEqual(latestPressureReading(history, today), { value: 1.4, date: today, time: "07:10" });
    assert.equal(carbonationPressureContext(history, today), "לחץ אחרון: 1.4 bar (היום בשעה 07:10)");
});

test("old pressure is dated, with time if present", () => {
    assert.equal(
        carbonationPressureContext([carb("2026-10-27_917", null, 0.8), carb("2026-10-28_0900", 2.1)], today),
        "לחץ אחרון: 0.8 bar (נמדד ב־27/10/2026 בשעה 09:17)",
    );
});

test("unknown and empty pressure are never shown as zero", () => {
    assert.equal(carbonationPressureContext([carb("2026-10-28_0900", 2.1, "")], today),
        "לחץ אחרון: אין מדידת לחץ זמינה");
    assert.equal(latestPressureReading([carb("2026-10-28_0900", 2.1, null)], today), null);
    assert.equal(latestPressureReading([carb("2026-10-28_0900", 2.1, "0")], today)?.value, 0);
});

test("future readings cannot affect today's recommendation", () => {
    assert.equal(latestPressureReading([
        { id: "2026-10-29_0900", pressure: 2.9 },
        { id: "2026-10-27_0900", pressure: 0.4 },
    ], today)?.value, 0.4);
});

test("only first-ever in-range carbonation reading qualifies for a pressure consideration", () => {
    const history = [
        carb("2026-10-22_1000", 2.12, 0.7),
        carb("2026-10-26_1000", 2.3, 0.8),
        carb("2026-10-28_1000", 2.45, 1.1),
    ];
    assert.deepEqual(firstInRangePressureAdvice(history, today, inRange), {
        direction: "lower", carbonation: 2.45,
        pressure: { value: 1.1, date: today, time: "10:00" },
    });
});

test("low pressure prompts considering a raise even when pressure was recorded yesterday", () => {
    const history = [
        carb("2026-10-25_0800", 2.20),
        carb("2026-10-27_0815", null, "0,49"),
        carb("2026-10-28_0900", 2.46),
    ];
    assert.equal(firstInRangePressureAdvice(history, today, inRange)?.direction, "raise");
});

test("thresholds are strict; 0.5 and 0.9 produce no suggestion", () => {
    for (const value of [0.5, 0.9, 0.7]) {
        assert.equal(firstInRangePressureAdvice([carb("2026-10-28_1000", 2.45, value)], today, inRange), null);
    }
    assert.equal(firstInRangePressureAdvice([carb("2026-10-28_1000", 2.45, 0)], today, inRange)?.direction, "raise");
    assert.equal(firstInRangePressureAdvice([carb("2026-10-28_1000", 2.45, 0.91)], today, inRange)?.direction, "lower");
});

test("previous in-range result permanently prevents a second first-hit recommendation", () => {
    const older = carb("2026-10-26_0900", 2.44, 0.45);
    const later = carb("2026-10-28_0900", 2.45, 1.1);
    assert.equal(firstInRangePressureAdvice([older, later], today, inRange), null);
    assert.equal(firstInRangePressureAdvice([carb("2026-10-28_0800", 2.44, 0.4), later], today, inRange), null);
});

test("retest outside the range and readings only from prior days do not qualify", () => {
    assert.equal(firstInRangePressureAdvice([
        carb("2026-10-28_0800", 2.45, 1.2),
        carb("2026-10-28_1100", 2.1, 1.2),
    ], today, inRange), null);
    assert.equal(firstInRangePressureAdvice([carb("2026-10-27_0900", 2.45, 1.2)], today, inRange), null);
});

test("empty carbonation measurements do not count as earlier valid readings", () => {
    assert.equal(firstInRangePressureAdvice([
        carb("2026-10-26_0900", "", 1.2),
        carb("2026-10-27_0900", null, 1.1),
        carb("2026-10-28_1010", "2,45", null),
    ], today, inRange)?.direction, "lower");
});

test("existing recommendation and account-switch integration stays wired", () => {
    const source = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    const app = read("../src/App.tsx");
    assert.match(source, /carbonationPressureContext\(sortedMeasurements, todayDate\)/);
    assert.match(source, /firstInRangeAdvice !== null/);
    assert.match(source, /!pressureHandledToday/);
    assert.match(app, /googleProvider\.setCustomParameters\(\{ prompt: "select_account" \}\)/);
    assert.match(app, /className="header-user-bar"/);
    assert.match(app, /className="header-switch-user" onClick=\{logout\}/);
});
