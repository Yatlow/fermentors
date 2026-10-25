import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/dashboard/actionKpis.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { calculateActionKpis, hasExplicitPressureChangeAction } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
// Load the pure scheduled-evidence rules without Firebase imports; the tests
// exercise real completion logic without any network or Firestore reads.
const scheduledSource = readFileSync(new URL("../src/SERVICES/cellering/scheduledCellarRecommendations.ts", import.meta.url), "utf8");
const scheduledJs = ts.transpileModule(scheduledSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText.replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];/g, "");
const { scheduledRecommendationCompletionDate, scheduledPressureDecisionEvidence, scheduledPressureDecisionConflictText, hasUpcomingBottomCarbonationDecision } = await import(
    "data:text/javascript;base64," + Buffer.from(scheduledJs).toString("base64")
);

const retestSource = readFileSync(new URL("../src/SERVICES/cellering/carbonationRetestPolicy.ts", import.meta.url), "utf8");
const retestJs = ts.transpileModule(retestSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { carbonationRetestPolicy, carbonationRetestPressureContext } = await import(
    "data:text/javascript;base64," + Buffer.from(retestJs).toString("base64")
);

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
    assert.deepEqual(result.other, { done: 1, total: 2 });
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

test("bottom carbonation belongs to other, never pressure or carbonation tests", () => {
    const pendingClose = pending("bottomCarbonationFollowUp", "1604", "11", { detail: "סגירת גיזוז מלמטה" });
    assert.deepEqual(count([pendingClose]), {
        pressure: { done: 0, total: 0 },
        other: { done: 0, total: 1 },
    });
    const complete = [
        done("bottom-carb-11", "גיזוז מלמטה", "1604", "11"),
        done("bottom-carb-close-11", "סגירת גיזוז מלמטה", "1604", "11"),
    ];
    assert.deepEqual(count([pendingClose], complete), {
        pressure: { done: 0, total: 0 },
        other: { done: 2, total: 2 },
    });
    assert.deepEqual(count([], [complete[0]]), {
        pressure: { done: 0, total: 0 },
        other: { done: 1, total: 1 },
    });
});
test("gas KPI is exclusively actual carbonation tests, not pressure corrections or bottom carbonation", () => {
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    assert.match(dashboard, /const carbCompletedToday = hasTodayCarbonation;/);
    assert.doesNotMatch(dashboard, /const carbCompletedToday = hasTodayCarbonation \|\|/);
    assert.doesNotMatch(dashboard, /"carbTest", "bottomCarbonationFollowUp"/);
    assert.match(dashboard, /addCompleted\(`bottom-carb-close-/);
});


test("scheduled bottom carbonation stays in Other KPI and matches its completion", () => {
    const task = pending("scheduled-bottom-123", "1602", "8", { scheduledActionType: "bottomCarbonation" });
    assert.deepEqual(count([task]), {
        pressure: { done: 0, total: 0 },
        other: { done: 0, total: 1 },
    });
    assert.deepEqual(count([task], [done("scheduled-bottom-123", "גיזוז מלמטה", "1602", "8")]), {
        pressure: { done: 0, total: 0 },
        other: { done: 1, total: 1 },
    });
});

test("scheduled bottom carbonation requires actual start, not test, pressure or closure", () => {
    const scheduled = {
        id: "abc", tankNumber: "8", batchNumber: "1602",
        actionType: "bottomCarbonation", dueDate: "2026-10-20", status: "active",
    };
    const history = [
        { id: "2026-10-19_1200", notes: "תחילת גיזוז מלמטה" },
        { id: "2026-10-20_0830", carbonation: 2.4 },
        { id: "2026-10-20_0840", notes: "סגירת גיזוז מלמטה בשעה 08:40 על 1.5 bar" },
        { id: "2026-10-20_0900", notes: "הורדת לחץ ל 1.3 bar" },
    ];
    assert.equal(scheduledRecommendationCompletionDate(scheduled, history), null);
    assert.equal(
        scheduledRecommendationCompletionDate(scheduled, [
            ...history, { id: "2026-10-20_1000", notes: "תחילת גיזוז מלמטה בשעה 10:00" }
        ]),
        "2026-10-20",
    );
});

test("today's pressure comparison uses actual daily measurements only", () => {
    const history = [
        { id: "2026-10-19_1000", pressure: 0.88 },
        { id: "2026-10-20_0800", pressure: 1.2 },
        { id: "2026-10-20_1045", pressure: 1.34 },
    ];
    assert.match(
        carbonationRetestPressureContext(history, "2026-10-20") ?? "",
        /לחץ היום: 1.34 bar.*לחץ במדידה הקודמת היום: 1.2 bar.*הפרש: עלייה של 0.14 bar/,
    );
    assert.equal(carbonationRetestPressureContext(history, "2026-10-21"), null);
    const policy = carbonationRetestPolicy([
        { id: "2026-10-18_1000", carbonation: 2.1 },
        ...history,
    ], "2026-10-20");
    assert.equal(policy.due, true);
    assert.equal(policy.waitReason, "cadence");
});

test("scheduled start is wired to the bottom-carbonation quick report", () => {
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    const panel = readFileSync(new URL("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx", import.meta.url), "utf8");
    assert.match(panel, /<option value="bottomCarbonation">גיזוז מלמטה<\/option>/);
    assert.match(dashboard, /bottomCarbonation: "גיזוז מלמטה התחלה"/);
    assert.match(dashboard, /!completedScheduledBottomCarbonation/);
});


test("pending bottom-carbonation replaces only its batch's automatic carbonation-pressure advice", () => {
    const rows = [
        { id: "future-bottom", tankNumber: "8", batchNumber: "1602", actionType: "bottomCarbonation", dueDate: "2026-10-22", status: "active" },
        { id: "cancelled-bottom", tankNumber: "9", batchNumber: "1603", actionType: "bottomCarbonation", dueDate: "2026-10-22", status: "cancelled" },
        { id: "past-bottom", tankNumber: "10", batchNumber: "1604", actionType: "bottomCarbonation", dueDate: "2026-10-18", status: "active" },
        { id: "test-only", tankNumber: "11", batchNumber: "1605", actionType: "carbTest", dueDate: "2026-10-22", status: "active" },
    ];
    assert.equal(hasUpcomingBottomCarbonationDecision(rows, "8", "1602", "2026-10-20"), true);
    assert.equal(hasUpcomingBottomCarbonationDecision(rows, "8", "#1602", "2026-10-22"), true);
    assert.equal(hasUpcomingBottomCarbonationDecision(rows, "8", "1602", "2026-10-23"), false);
    assert.equal(hasUpcomingBottomCarbonationDecision(rows, "8", "other-batch", "2026-10-20"), false);
    for (const [tank, batch] of [["9", "1603"], ["10", "1604"], ["11", "1605"]]) {
        assert.equal(hasUpcomingBottomCarbonationDecision(rows, tank, batch, "2026-10-20"), false);
    }
});

test("both cellar views suppress out-of-spec pressure advice when bottom carbonation is planned", () => {
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    const info = readFileSync(new URL("../src/components/dashboard/FermentorInfoBox.tsx", import.meta.url), "utf8");
    assert.match(dashboard, /const hasPlannedBottomCarbonation = hasUpcomingBottomCarbonationDecision\(/);
    assert.match(dashboard, /hasPlannedBottomCarbonation && recommendation\.actionType === "pressureChange"/);
    assert.match(info, /const suppressAutomaticCarbPressureAdvice =/);
    assert.match(info, /hasPlannedBottomCarbonation &&/);
    assert.match(info, /!suppressAutomaticCarbPressureAdvice/);
});

test("no pressure comparison when today lacks pressure, even if yesterday has it", () => {
    assert.equal(carbonationRetestPressureContext(
        [{ id: "2026-10-19_0900", pressure: 1.4 }, { id: "2026-10-20_0900", carbonation: 2.2 }],
        "2026-10-20"
    ), null);
    assert.equal(carbonationRetestPressureContext(
        [{ id: "2026-10-20_0900", pressure: 1.4 }],
        "2026-10-20"
    ), "לחץ היום: 1.4 bar");
});


test("scheduled cooling requires an executed cooling report, not a request to cool", () => {
    const row = {
        id: "cool-17", tankNumber: "17", batchNumber: "1609",
        actionType: "coolDown", dueDate: "2026-10-25", status: "active",
    };
    const requests = [
        { id: "2026-10-25_0710", notes: "נא לבצע קירור היום" },
        { id: "2026-10-25_0730", notes: "בדיקת גיזוז 2.4, ללא קירור" },
        { id: "2026-10-24_0745", notes: "קירור מיכל ל0.3°" },
    ];
    assert.equal(scheduledRecommendationCompletionDate(row, requests), null);
    assert.equal(scheduledRecommendationCompletionDate(row, [
        ...requests, { id: "2026-10-25_0815", notes: "קירור מיכל ל0.3°" },
    ]), "2026-10-25");
});

test("free-form cellar instruction is never automatically completed from measurement text", () => {
    const row = {
        id: "other-17", tankNumber: "17", batchNumber: "1609",
        actionType: "other", dueDate: "2026-10-25",
        note: "דחוף CO₂ מלמטה בועות גדולות", status: "active",
    };
    assert.equal(scheduledRecommendationCompletionDate(row, [
        { id: "2026-10-25_0830", notes: "תחילת גיזוז מלמטה" },
        { id: "2026-10-25_0910", notes: row.note },
    ]), null);
});

test("multiple free-form decisions in one tank count independently under Other KPI", () => {
    const alerts = [
        pending("scheduled-first", "1609", "17", { scheduledActionType: "other" }),
        pending("scheduled-second", "1609", "17", { scheduledActionType: "other" }),
        pending("scheduled-cooling", "1609", "17", { scheduledActionType: "coolDown" }),
    ];
    assert.deepEqual(count(alerts), {
        pressure: { done: 0, total: 0 },
        other: { done: 0, total: 3 },
    });
    assert.deepEqual(count(alerts, [done("scheduled-first", "אחר", "1609", "17")]), {
        pressure: { done: 0, total: 0 },
        other: { done: 1, total: 3 },
    });
    assert.deepEqual(count(alerts, [
        done("scheduled-first", "אחר", "1609", "17"),
        done("scheduled-cooling", "קירור", "1609", "17"),
    ]), {
        pressure: { done: 0, total: 0 },
        other: { done: 2, total: 3 },
    });
});

test("scheduled free-form and cooling UI remains visible and reportable", () => {
    const panel = readFileSync(new URL("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx", import.meta.url), "utf8");
    const info = readFileSync(new URL("../src/components/dashboard/FermentorInfoBox.tsx", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    assert.match(panel, /<option value="coolDown">קירור<\/option>/);
    assert.match(panel, /<option value="other">אחר — הוראה חופשית<\/option>/);
    assert.match(panel, /actionType === "other" && !note\.trim\(\)/);
    assert.match(panel, /actionType !== "other" && existing\.some/);
    assert.match(panel, /completeFreeform\(row\.manualId!/);
    assert.match(panel, /<textarea rows=\{3\}/);
    assert.match(info, /if \(row\.actionType === "yeastDrop"\) return !naturalYeastRecommendation/);
    assert.match(dashboard, /if \(row\.actionType === "yeastDrop"\) return !naturalYeast/);
    assert.match(dashboard, /coolDown: "קירור"/);
});

test("ordinary scheduled pressure action closes on any numeric change regardless of target", () => {
    const task = {
        id: "ordinary-1", tankNumber: "11", batchNumber: "1701", actionType: "pressureChange",
        dueDate: "2026-10-25", targetPressure: 1.2, createdByIsCellarManager: false,
        createdAt: "2026-10-25T14:00:00", status: "active",
    };
    assert.equal(scheduledRecommendationCompletionDate(task, [
        { id: "2026-10-25_0830", notes: "העלאת לחץ ל: 1.6 bar" },
    ]), "2026-10-25");
    assert.equal(scheduledPressureDecisionConflictText(task, [
        { id: "2026-10-25_0830", notes: "העלאת לחץ ל: 1.6 bar" },
    ]), null);
});

test("manager pressure target retroactively overrides earlier same-day conflicting action", () => {
    const task = {
        id: "manager-1", tankNumber: "11", batchNumber: "1701", actionType: "pressureChange",
        dueDate: "2026-10-25", targetPressure: 1.2, createdByIsCellarManager: true,
        createdBy: "manager@example.com", createdAt: "2026-10-25T14:00:00", status: "active",
    };
    const earlierReport = [{ id: "2026-10-25_0830", notes: "הורדת לחץ ל: 1.6 bar" }];
    assert.equal(scheduledRecommendationCompletionDate(task, earlierReport), null);
    assert.deepEqual(scheduledPressureDecisionEvidence(task, earlierReport), {
        completionDate: null, latestPressure: 1.6, hasPressureChange: true, mismatched: true,
    });
    assert.equal(scheduledPressureDecisionConflictText(task, earlierReport),
        "משתמש manager@example.com החליט על שינוי לחץ ל־1.2 bar, שינוי לחץ בוצע ל־1.6 bar — יש לשנות ל־1.2 bar בהתאם להמלצה");
});

test("manager target accepts an earlier same-day matching action, including trailing zeros", () => {
    const task = {
        id: "manager-2", tankNumber: "11", batchNumber: "1701", actionType: "pressureChange",
        dueDate: "2026-10-25", targetPressure: 1.2, createdByIsCellarManager: true,
        createdAt: "2026-10-25T15:00:00", status: "active",
    };
    assert.equal(scheduledRecommendationCompletionDate(task, [
        { id: "2026-10-25_0720", notes: "העלאת לחץ ל: 1.20 bar" },
    ]), "2026-10-25");
    assert.equal(scheduledPressureDecisionConflictText(task, [
        { id: "2026-10-25_0720", notes: "העלאת לחץ ל: 1.20 bar" },
    ]), null);
});

test("the latest actual same-day pressure report determines manager instruction state", () => {
    const task = {
        id: "manager-3", tankNumber: "11", batchNumber: "1701", actionType: "pressureChange",
        dueDate: "2026-10-25", targetPressure: 1.2, createdByIsCellarManager: true,
        createdAt: "2026-10-25T16:00:00", status: "active",
    };
    const changes = [
        { id: "2026-10-25_1030", notes: "הורדת לחץ ל: 1.4 bar" },
        { id: "2026-10-25_1100", notes: "הורדת לחץ ל: 1.2 bar" },
    ];
    assert.equal(scheduledRecommendationCompletionDate(task, changes), "2026-10-25");
    assert.equal(scheduledRecommendationCompletionDate(task, [
        ...changes, { id: "2026-10-25_1130", notes: "העלאת לחץ ל: 1.5 bar" },
    ]), null);
    assert.equal(scheduledRecommendationCompletionDate(task, [
        ...changes, { id: "2026-10-25_1130", notes: "העלאת לחץ ל: 1.5 bar" },
        { id: "2026-10-25_1240", notes: "הורדת לחץ ל: 1.2 bar" },
    ]), "2026-10-25");
});

test("a pressure measurement, suggestion, or prior-day change is never an action completion", () => {
    const task = {
        id: "manager-4", tankNumber: "11", batchNumber: "1701", actionType: "pressureChange",
        dueDate: "2026-10-25", targetPressure: 1.2, createdByIsCellarManager: true,
        status: "active",
    };
    assert.equal(scheduledRecommendationCompletionDate(task, [
        { id: "2026-10-24_1700", notes: "הורדת לחץ ל: 1.2 bar" },
        { id: "2026-10-25_0730", pressure: 1.2, notes: "מומלץ לבצע שינוי לחץ" },
    ]), null);
    assert.equal(scheduledPressureDecisionConflictText(task, [
        { id: "2026-10-25_0730", pressure: 1.5, notes: "מומלץ להוריד לחץ ל: 1.2 bar" },
    ]), null);
});

test("manager snapshot and tank/dashboard completion gates use numeric pressure evidence", () => {
    const service = readFileSync(new URL("../src/SERVICES/cellering/scheduledCellarRecommendations.ts", import.meta.url), "utf8");
    const info = readFileSync(new URL("../src/components/dashboard/FermentorInfoBox.tsx", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    assert.match(service, /data\\.isCellarManager === true \\|\\| data\\.isAdmin === true/);
    assert.match(service, /createdByIsCellarManager: creatorIsCellarManager/);
    assert.doesNotMatch(service, /reportedAt < createdAt/);
    assert.match(info, /row\\.actionType !== "pressureChange"/);
    assert.match(info, /scheduledRecommendationCompletionDate\\(row, measurements\\)/);
    assert.match(info, /scheduledPressureDecisionConflictText\\(row, measurements\\)/);
    assert.match(dashboard, /scheduledPressureDecisionConflictText\\(row, measurements\\)/);
});
