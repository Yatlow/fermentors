import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/dashboard/actionKpis.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { calculateActionKpis, hasExplicitPressureChangeAction } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const pending = (recommendationKey, batchNumber = "1601", tankNumber = "8", extra = {}) =>
    ({ id: recommendationKey, recommendationKey, batchNumber, tankNumber, ...extra });
const done = (id, title, batchNumber = "1601", tankNumber = "8") =>
    ({ id, title, batchNumber, tankNumber });
const count = (alerts, actions = []) => calculateActionKpis(alerts, actions);

test("counts two different other actions in one batch separately", () => {
    assert.deepEqual(count([pending("dryHop"), pending("coolDown")]).other, { done: 0, total: 2 });
});
test("pressure changes only; vent adjustment and closure belong to other", () => {
    const result = count([pending("pressureAdjustment", "1601", "8", { scheduledActionType: "pressureChange" }), pending("pressureClose"), pending("scheduled-v1", "1601", "8", { scheduledActionType: "other", detail: "כיוון פורק" })]);
    assert.deepEqual(result.pressure, { done: 0, total: 1 });
    assert.deepEqual(result.other, { done: 0, total: 2 });
});
test("same action in different batches counts twice", () => {
    assert.deepEqual(count([pending("dryHop", "1601"), pending("dryHop", "1602")]).other, { done: 0, total: 2 });
});
test("same scheduled action is not counted twice when completed", () => {
    assert.deepEqual(count([pending("scheduled-abc", "1601", "8", { scheduledActionType: "pressureChange" })], [done("scheduled-abc", "שינוי לחץ")]).pressure, { done: 1, total: 1 });
});
test("distinct scheduled actions of same type count separately", () => {
    assert.deepEqual(count([pending("scheduled-a", "1601", "8", { scheduledActionType: "pressureChange" }), pending("scheduled-b", "1601", "8", { scheduledActionType: "pressureChange" })]).pressure, { done: 0, total: 2 });
});
test("ordinary completion matches the corresponding recommendation", () => {
    assert.deepEqual(count([pending("pressureAdjustment", "1601", "8", { scheduledActionType: "pressureChange" })], [done("pressure-adjust-8", "שינוי לחץ")]).pressure, { done: 1, total: 1 });
});
test("unknown actions and measurement rounds are excluded", () => {
    assert.deepEqual(count([pending("measurementRound"), pending("unknownFutureAction")], [done("mystery", "פעולה לא מוכרת")]), { pressure: { done: 0, total: 0 }, other: { done: 0, total: 0 } });
});
test("completed actions without pending recommendations still count", () => {
    assert.deepEqual(count([], [done("reported-vent-adjust-8", "כיוון פורק"), done("dryhop-8", "דרייהופ")]).other, { done: 2, total: 2 });
});
test("multiple categories in one tank are independent", () => {
    const result = count([pending("pressureAdjustment", "1601", "8", { scheduledActionType: "pressureChange" }), pending("dryHop"), pending("carbTest"), pending("warmYeastDrop")]);
    assert.deepEqual(result.pressure, { done: 0, total: 1 });
    assert.deepEqual(result.other, { done: 0, total: 1 });
});

test("recommendation and ordinary dry hop report represent one action", () => {
    assert.deepEqual(count([pending("dryHop")], [done("dryhop-8", "דרייהופ")]).other, { done: 1, total: 1 });
});
test("two distinct completed scheduled actions remain two actions", () => {
    const result = count([], [done("scheduled-a", "כיוון פורק"), done("scheduled-b", "כיוון פורק")]);
    assert.deepEqual(result.other, { done: 2, total: 2 });
});


test("carb recommendations mentioning pressure changes stay out of pressure KPI", () => {
    const result = count([
        pending("carbTest", "1607", "16", { detail: "לפני יומיים בוצע שינוי לחץ; מומלץ לבצע בדיקת גיזוז חוזרת" }),
        pending("bottomCarbonationFollowUp", "1604", "17", { detail: "גיזוז מלמטה ומומלץ שינוי לחץ בעת הצורך" }),
        pending("scheduled-carb-11", "1605", "11", { scheduledActionType: "carbTest", detail: "שינוי לחץ בעקבות בדיקת גיזוז" }),
    ], [
        done("bottom-carb-8", "גיזוז מלמטה", "1606", "8"),
        done("carb-11", "בדיקת גיזוז", "1605", "11"),
    ]);
    assert.deepEqual(result.pressure, { done: 0, total: 0 });
    assert.deepEqual(result.other, { done: 0, total: 0 });
});

test("natural vent recommendation counts as other, not pressure", () => {
    const result = count([
        pending("pressureAdjustment", "1601", "19", { scheduledActionType: "ventAdjust", detail: "מומלץ לכוון פורק" }),
    ], [done("reported-vent-adjust-19", "כיוון פורק", "1601", "19")]);
    assert.deepEqual(result.pressure, { done: 0, total: 0 });
    assert.deepEqual(result.other, { done: 1, total: 1 });
});

test("vent-adjust ignored screenshot: toggling tank 3 only changes other, never pressure", () => {
    const pressures = [
        pending("scheduled-p1", "1601", "7", { scheduledActionType: "pressureChange" }),
        pending("scheduled-p2", "1602", "9", { scheduledActionType: "pressureChange" }),
        pending("scheduled-p3", "1603", "11", { scheduledActionType: "pressureChange" }),
    ];
    const vent = pending("pressureAdjustment", "1604", "3", {
        scheduledActionType: "ventAdjust",
        detail: "מומלץ לכוון פורק ל 1.5, הלחץ כרגע נמוך (1.4)",
    });
    assert.deepEqual(count([...pressures, vent]), {
        pressure: { done: 0, total: 3 },
        other: { done: 0, total: 1 },
    });
    assert.deepEqual(count(pressures), {
        pressure: { done: 0, total: 3 },
        other: { done: 0, total: 0 },
    });
    assert.deepEqual(count([vent], [done("reported-vent-adjust-3", "כיוון פורק", "1604", "3")]), {
        pressure: { done: 0, total: 0 },
        other: { done: 1, total: 1 },
    });
});

test("pressure adjustment without an explicit kind must never guess pressure", () => {
    const ambiguous = pending("pressureAdjustment", "1604", "3", { detail: "מומלץ לכוון פורק ל 1.5" });
    assert.deepEqual(count([ambiguous]), {
        pressure: { done: 0, total: 0 },
        other: { done: 0, total: 0 },
    });
});

test("only actual raising/lowering constitutes pressure-change completion evidence", () => {
    for (const note of [
        "כיוון פורק ל: 1.5 bar",
        "סגירת נשם, כיוון פורק ל 1.5",
        "גיזוז מלמטה",
        "תחילת גיזוז מלמטה",
        "שינוי לחץ בעקבות בדיקת גיזוז מומלץ",
        "בדיקת גיזוז",
    ]) assert.equal(hasExplicitPressureChangeAction(note), false, note);
    for (const note of [
        "העלאת לחץ ל: 1.5 bar",
        "הורדת לחץ ל: 1.2 bar",
        "מומלץ להעלות לחץ",
        "מומלץ להוריד לחץ",
    ]) assert.equal(hasExplicitPressureChangeAction(note), true, note);
});

test("dashboard marks vent recommendation by explicit action type, not tank stage", () => {
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    const engine = readFileSync(new URL("../src/SERVICES/cellering/calculateCelleringRecomendations.ts", import.meta.url), "utf8");
    assert.match(engine, /actionType: coldCarbNeedsPressureAdjustment \? "pressureChange" as const : "ventAdjust" as const/);
    assert.match(dashboard, /scheduledActionType: recommendation\.actionType/);
    assert.doesNotMatch(dashboard, /recommendation\.recommendationKey === "pressureAdjustment" && tank\.stage/);
    assert.match(dashboard, /ventAdjust: "פורק"/);
});
