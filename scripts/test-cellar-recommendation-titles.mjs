import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// The title formatter is intentionally pure; no Firebase or browser globals.
const source = readFileSync(new URL("../src/SERVICES/dashboard/cellarRecommendationTitles.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { cellarRecommendationTitle: title } = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const format = (key, overrides = {}) =>
    title({ tankNumber: 7, recommendationKey: key, ...overrides });

test("natural recommendations have action-specific titles", () => {
    const pairs = [
        ["dryHop", "המלצה לביצוע דרייהופ"],
        ["pressureClose", "המלצה לסגירת מיכל"],
        ["warmYeastDrop", "המלצה להורדת שמרים במהלך תסיסה"],
        ["warmYeastDropCompletion", "המלצה להשלמת הורדת שמרים חמה"],
        ["yeastDropAfterCooling", "המלצה להורדת שמרים אחרי קירור"],
        ["coldYeastDropCompletion", "המלצה להשלמת הורדת שמרים קרה"],
        ["wedYeastDropOnThu", "המלצה להורדת שמרים לפני אריזה"],
        ["bottomCarbonation", "המלצה להתחלת גיזוז מלמטה"],
        ["bottomCarbonationFollowUp", "המלצה לסגירת גיזוז מלמטה"],
        ["diacetylRest", "המלצה לביצוע מנוחת דיאצטיל"],
        ["neglectedStatus", "המלצה לבדיקת מצב המיכל"],
        ["coolDown", "המלצה להתחלת קירור"],
    ];
    for (const [key, expected] of pairs) {
        assert.equal(format(key), `מיכל 7: ${expected}`, key);
    }
});

test("yeast timing remains distinguishable", () => {
    assert.equal(format("warmYeastDrop", { titleVariant: "afterDryHop" }),
        "מיכל 7: המלצה להורדת שמרים אחרי דרייהופ");
    assert.equal(format("yeastDropAfterCooling", { titleVariant: "additionalAfterSunday" }),
        "מיכל 7: המלצה להורדת שמרים נוספת");
});

test("first, overdue, repeated, treated and packaging carbonation tests differ", () => {
    const pairs = [
        ["firstAfterCooling", "המלצה לבדיקת גיזוז ראשונה אחרי קירור"],
        ["firstAfterCoolingOverdue", "המלצה לבדיקת גיזוז ראשונה באיחור"],
        ["retest", "המלצה לבדיקת גיזוז חוזרת"],
        ["retestAfterPressureChange", "המלצה לבדיקת גיזוז חוזרת אחרי שינוי לחץ"],
        ["retestAfterBottomCarbonation", "המלצה לבדיקת גיזוז חוזרת אחרי גיזוז מלמטה"],
        ["prePackaging", "המלצה לבדיקת גיזוז לפני אריזה"],
    ];
    for (const [titleVariant, expected] of pairs) {
        assert.equal(format("carbTest", { titleVariant }), `מיכל 7: ${expected}`);
    }
    assert.equal(format("carbTest"), "מיכל 7: המלצה לבדיקת גיזוז");
});

test("pressure status and pressure direction remain distinct", () => {
    assert.equal(format("pressureAdjustment", { titleVariant: "ventAdjust", actionType: "ventAdjust" }),
        "מיכל 7: המלצה לכיוון פורק");
    assert.equal(format("pressureAdjustment", { titleVariant: "firstInRange" }),
        "מיכל 7: המלצה לבחינת הלחץ לאחר גיזוז תקין ראשון");
    assert.equal(format("pressureAdjustment", { titleVariant: "outOfSpec", carbonationTestOutOfSpec: true }),
        "מיכל 7: המלצה לשינוי לחץ לאחר בדיקת גיזוז לא תקינה");
    assert.equal(format("pressureAdjustment", { titleVariant: "outOfSpec", carbonationTestOutOfSpec: true, pressureSuggestion: "raise" }),
        "מיכל 7: המלצה להעלאת לחץ");
    assert.equal(format("pressureAdjustment", { titleVariant: "outOfSpec", carbonationTestOutOfSpec: true, pressureSuggestion: "lower" }),
        "מיכל 7: המלצה להורדת לחץ");
});

test("persisted scheduled actions are brewer decisions, including legacy rows", () => {
    assert.equal(format("scheduled-abc", { actionType: "carbTest" }),
        "מיכל 7: החלטת סלרינג – בדיקת גיזוז");
    assert.equal(format("scheduled-abc", { actionType: "yeastDrop" }),
        "מיכל 7: החלטת סלרינג – הורדת שמרים");
    assert.equal(format("scheduled-abc", { actionType: "coolDown" }),
        "מיכל 7: החלטת סלרינג – קירור");
    assert.equal(format("scheduled-abc", { actionType: "bottomCarbonation" }),
        "מיכל 7: החלטת סלרינג – גיזוז מלמטה");
    assert.equal(format("scheduled-abc", { actionType: "pressureChange", userDecision: true, pressureDirection: "raise" }),
        "מיכל 7: החלטת סלרינג – העלאת לחץ");
    assert.equal(format("scheduled-abc", { actionType: "pressureChange", userDecision: true, pressureDirection: "lower" }),
        "מיכל 7: החלטת סלרינג – הורדת לחץ");
    assert.equal(format("scheduled-abc", { actionType: "other", userDecision: true, scheduledNote: "בדיקת ריח" }),
        "מיכל 7: החלטת סלרינג – בדיקת ריח");
});

test("cooling caveats stay visibly non-actionable", () => {
    assert.equal(format("coolDown", { reviewOnly: true }), "מיכל 7: סייג לפני קירור");
});


test("every system recommendation starts with המלצה after the tank number", () => {
    const naturalKeys = [
        "dryHop", "pressureClose", "warmYeastDrop", "warmYeastDropCompletion",
        "yeastDropAfterCooling", "coldYeastDropCompletion", "wedYeastDropOnThu",
        "carbTest", "bottomCarbonation", "bottomCarbonationFollowUp",
        "diacetylRest", "neglectedStatus", "coolDown", "pressureAdjustment",
        "anUnrecognizedRecommendation",
    ];
    for (const recommendationKey of naturalKeys) {
        assert.match(format(recommendationKey), /^מיכל 7: המלצה(?: |$)/, recommendationKey);
    }
    for (const titleVariant of [
        "firstAfterCooling", "firstAfterCoolingOverdue", "retest", "retestAfterPressureChange",
        "retestAfterBottomCarbonation", "prePackaging",
    ]) {
        assert.match(format("carbTest", { titleVariant }), /^מיכל 7: המלצה(?: |$)/, titleVariant);
    }
    for (const actionType of [
        "carbTest", "yeastDrop", "coolDown", "bottomCarbonation", "pressureChange", "other", "unknown",
    ]) {
        assert.match(format("scheduled-test", { actionType }), /^מיכל 7: החלטת סלרינג(?: – .+)?$/, actionType);
    }
    assert.equal(format("scheduled-test", { actionType: "pressureChange", pressureDirection: "raise" }),
        "מיכל 7: החלטת סלרינג – העלאת לחץ");
    assert.equal(format("scheduled-test", { actionType: "other", scheduledNote: "בדיקת ריח" }),
        "מיכל 7: החלטת סלרינג – בדיקת ריח");
    // Source-of-truth exceptions: factual warning and user-authored decisions
    // are deliberately not mislabelled as automatic recommendations.
    assert.equal(format("coolDown", { reviewOnly: true }), "מיכל 7: סייג לפני קירור");
    assert.equal(format("scheduled-test", { actionType: "yeastDrop", userDecision: true }),
        "מיכל 7: החלטת סלרינג – הורדת שמרים");
});

test("scheduled user decisions remain decisions without source/userDecision metadata", () => {
    // Legacy documents did not always include source: "user".
    assert.equal(format("scheduled-legacy", { actionType: "carbTest", userDecision: false }),
        "מיכל 7: החלטת סלרינג – בדיקת גיזוז");
    assert.equal(format("scheduled-legacy", { actionType: "pressureChange", pressureDirection: "lower" }),
        "מיכל 7: החלטת סלרינג – הורדת לחץ");
    assert.equal(format("scheduled-legacy", { actionType: "other", scheduledNote: "בדיקת ארומה" }),
        "מיכל 7: החלטת סלרינג – בדיקת ארומה");
});

test("dashboard and forecast distinguish scheduled decisions from calculated forecasts", () => {
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    const forecast = readFileSync(new URL("../src/components/cellering/CellaringForecast.tsx", import.meta.url), "utf8");
    const schedule = readFileSync(new URL("../src/SERVICES/cellering/scheduledCellarRecommendations.ts", import.meta.url), "utf8");
    const panel = readFileSync(new URL("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx", import.meta.url), "utf8");
    assert.match(dashboard, /recommendationKey: `scheduled-\$\{row\.id\}`/);
    assert.match(dashboard, /userDecision: true,/);
    assert.ok(!dashboard.includes('row.source === "user" || row.actionType === "pressureChange"'));
    assert.match(dashboard, /בוצע לפי החלטת סלרינג/);
    assert.ok(!dashboard.includes("בוצע לפי המלצה מתוזמנת"));
    assert.match(forecast, /<span className="cellar-forecast-type">החלטת סלרינג<\/span>/);
    assert.match(forecast, /cellar-forecast-conditional/);
    assert.match(schedule, /const sourceFields = \{ source: "user" as const \};/);
    assert.match(panel, /label: `החלטת סלרינג · \$\{scheduledActionLabel\(row\.actionType\)\}`/);
});

test("title depends on structured evidence, never reason copy", () => {
    const engine = readFileSync(new URL("../src/SERVICES/cellering/calculateCelleringRecomendations.ts", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    assert.ok(engine.includes('retestPolicy.waitReason === "ordinary_pressure"'));
    assert.ok(engine.includes('retestPolicy.waitReason === "bottom_carbonation"'));
    assert.ok(engine.includes("requiresCarbTest.titleVariant = CoolAge > 1"));
    assert.ok(engine.includes("requiresWarmYeastDrop.titleVariant = isHoppy"));
    assert.ok(dashboard.includes("title: cellarRecommendationTitle("));
    assert.ok(dashboard.includes("titleVariant: row.titleVariant"));
});
