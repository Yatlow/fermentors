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
        ["neglectedStatus", "נדרשת תשומת לב"],
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
        ["firstAfterCoolingOverdue", "בדיקת גיזוז ראשונה באיחור"],
        ["retest", "המלצה לבדיקת גיזוז חוזרת"],
        ["retestAfterPressureChange", "בדיקת גיזוז חוזרת אחרי שינוי לחץ"],
        ["retestAfterBottomCarbonation", "בדיקת גיזוז חוזרת אחרי גיזוז מלמטה"],
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

test("scheduled actions and user decisions preserve provenance", () => {
    assert.equal(format("scheduled-abc", { actionType: "carbTest" }),
        "מיכל 7: בדיקת גיזוז מתוזמנת");
    assert.equal(format("scheduled-abc", { actionType: "yeastDrop" }),
        "מיכל 7: הורדת שמרים מתוזמנת");
    assert.equal(format("scheduled-abc", { actionType: "coolDown" }),
        "מיכל 7: קירור מתוזמן");
    assert.equal(format("scheduled-abc", { actionType: "bottomCarbonation" }),
        "מיכל 7: גיזוז מלמטה מתוזמן");
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

test("title depends on structured evidence, never reason copy", () => {
    const engine = readFileSync(new URL("../src/SERVICES/cellering/calculateCelleringRecomendations.ts", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
    assert.match(engine, /retestPolicy\\.waitReason === "ordinary_pressure"/);
    assert.match(engine, /retestPolicy\\.waitReason === "bottom_carbonation"/);
    assert.match(engine, /requiresCarbTest\\.titleVariant = CoolAge > 1/);
    assert.match(engine, /requiresWarmYeastDrop\\.titleVariant = isHoppy/);
    assert.match(dashboard, /title: cellarRecommendationTitle\\(/);
    assert.match(dashboard, /titleVariant: row\\.titleVariant/);
});
