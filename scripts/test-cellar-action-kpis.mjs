import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/dashboard/actionKpis.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { calculateActionKpis } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const pending = (recommendationKey, batchNumber = "1601", tankNumber = "8", extra = {}) =>
    ({ id: recommendationKey, recommendationKey, batchNumber, tankNumber, ...extra });
const done = (id, title, batchNumber = "1601", tankNumber = "8") =>
    ({ id, title, batchNumber, tankNumber });
const count = (alerts, actions = []) => calculateActionKpis(alerts, actions);

test("counts two different other actions in one batch separately", () => {
    assert.deepEqual(count([pending("dryHop"), pending("coolDown")]).other, { done: 0, total: 2 });
});
test("pressure changes only; vent adjustment and closure belong to other", () => {
    const result = count([pending("pressureAdjustment"), pending("pressureClose"), pending("scheduled-v1", "1601", "8", { scheduledActionType: "other", detail: "כיוון פורק" })]);
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
    assert.deepEqual(count([pending("pressureAdjustment")], [done("pressure-adjust-8", "שינוי לחץ")]).pressure, { done: 1, total: 1 });
});
test("unknown actions and measurement rounds are excluded", () => {
    assert.deepEqual(count([pending("measurementRound"), pending("unknownFutureAction")], [done("mystery", "פעולה לא מוכרת")]), { pressure: { done: 0, total: 0 }, other: { done: 0, total: 0 } });
});
test("completed actions without pending recommendations still count", () => {
    assert.deepEqual(count([], [done("reported-vent-adjust-8", "כיוון פורק"), done("dryhop-8", "דרייהופ")]).other, { done: 2, total: 2 });
});
test("multiple categories in one tank are independent", () => {
    const result = count([pending("pressureAdjustment"), pending("dryHop"), pending("carbTest"), pending("warmYeastDrop")]);
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
        pending("pressureAdjustment", "1601", "19", { scheduledActionType: "other", detail: "מומלץ לכוון פורק" }),
    ], [done("reported-vent-adjust-19", "כיוון פורק", "1601", "19")]);
    assert.deepEqual(result.pressure, { done: 0, total: 0 });
    assert.deepEqual(result.other, { done: 1, total: 1 });
});
