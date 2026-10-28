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
const yeastModule = ts.transpileModule(read("../src/SERVICES/cellering/coolingYeastTiming.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { latestCompletedYeastDropDate, yeastDropAllowsCooling } =
    await import("data:text/javascript;base64," + Buffer.from(yeastModule).toString("base64"));


test("today pressure is shown without a measured-at annotation, independently of carbonation", () => {
    const history = [
        carb("2026-10-28_1045", "2.10"),
        { id: "2026-10-27_0940", pressure: "1,25" },
        { id: "2026-10-28_0710", pressure: "1.4" },
        { id: "2026-10-27_1755", pressure: "1.7" },
    ];
    assert.deepEqual(latestPressureReading(history, today), { value: 1.4, date: today, time: "07:10" });
    assert.equal(carbonationPressureContext(history, today), "לחץ במיכל: 1.4 bar");
});

test("old pressure uses measured-at relative calendar days and never dates or times", () => {
    assert.equal(
        carbonationPressureContext([carb("2026-10-27_917", null, 0.8), carb("2026-10-28_0900", 2.1)], today),
        "לחץ במיכל: 0.8 bar (נמדד אתמול)",
    );
    assert.equal(carbonationPressureContext([carb("2026-10-26_2359", 2, 0.7)], today), "לחץ במיכל: 0.7 bar (נמדד לפני יומיים)");
    assert.equal(carbonationPressureContext([carb("2026-10-25_0001", 2, 0.6)], today), "לחץ במיכל: 0.6 bar (נמדד לפני שלושה ימים)");
    assert.equal(carbonationPressureContext([carb("2026-09-28_1000", 2, 0.5)], today), "לחץ במיכל: 0.5 bar (נמדד לפני 30 ימים)");
    assert.equal(carbonationPressureContext([carb("2026-12-31_2359", 2, 1.1)], "2027-01-01"), "לחץ במיכל: 1.1 bar (נמדד אתמול)");
});

test("unknown and empty pressure are never shown as zero", () => {
    assert.equal(carbonationPressureContext([carb("2026-10-28_0900", 2.1, "")], today),
        "לחץ במיכל: אין מדידת לחץ זמינה");
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

test("account switch and carbonation recommendations stay wired", () => {
    const source = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    const app = read("../src/App.tsx");
    assert.ok(source.includes("carbonationPressureContext(sortedMeasurements, todayDate)"));
    assert.ok(source.includes("firstInRangeAdvice !== null"));
    assert.ok(source.includes("!pressureHandledToday"));
    assert.ok(app.includes('googleProvider.setCustomParameters({ prompt: "select_account" })'));
    assert.ok(app.includes('className="header-account-menu"'));
    assert.ok(app.includes('className="header-account-trigger"'));
    assert.ok(app.includes('className="header-account-popover"'));
    assert.ok(app.includes('className="header-switch-user" onClick={logout}'));
});

test("compact account popover is alongside a centred logo and does not move navigation", () => {
    const app = read("../src/App.tsx");
    const css = read("../src/App.css");
    const brand = app.indexOf('className="header-brand-top"');
    const logo = app.indexOf('className="header-logo"', brand);
    const menu = app.indexOf('className="header-account-menu"', brand);
    const nav = app.indexOf('mobile-nav-shell', brand);
    assert.ok(brand >= 0 && brand < logo && logo < menu && menu < nav);
    assert.ok(css.includes("margin:0 auto!important"));
    assert.ok(css.includes("position:absolute; left:0; top:50%"));
    assert.ok(css.includes(".header-account-desktop-name { display:none; }"));
    assert.ok(css.includes(".header-account-popover"));
    assert.equal((app.match(/className="header-account-menu"/g) ?? []).length, 1);
});

test("tank 16: today's logged yeast drop blocks cooling until tomorrow", () => {
    const history = [
        { id: "2026-10-25_0900", plato: 4.2 },
        { id: "2026-10-28_0910", notes: "הורדת 7 דליי שמרים, לחץ אחרי 1.5 bar" },
    ];
    assert.equal(latestCompletedYeastDropDate(history, today), today);
    assert.equal(yeastDropAllowsCooling(history, today), false);
    assert.equal(yeastDropAllowsCooling(history, "2026-10-29"), true);
});

test("a second yeast drop today blocks cooling even if an earlier drop already occurred", () => {
    const history = [
        { id: "2026-10-26_0945", notes: "הורדת 4 דליי שמרים, לחץ אחרי 1.5 bar" },
        { id: "2026-10-28_1020", notes: "הורדת שמרים" },
    ];
    assert.equal(yeastDropAllowsCooling(history, today), false);
    assert.equal(yeastDropAllowsCooling(history, "2026-10-29"), true);
});

test("previous-day actual drop is sufficient for cooling timing; empty history is not", () => {
    assert.equal(yeastDropAllowsCooling([{ id: "2026-10-27_0910", notes: "הורדת 3 דליי שמרים" }], today), true);
    assert.equal(yeastDropAllowsCooling([{ id: "2026-10-27", notes: "הוצאת שמרים" }], today), true);
    assert.equal(yeastDropAllowsCooling([], today), false);
});

test("recommendation text and unrelated yeast mentions never unlock cooling", () => {
    const falseNotes = [
        "מומלץ לבצע הורדת שמרים",
        "המלצת הורדת שמרים",
        "לא בוצעה הורדת שמרים",
        "לאחר הורדת שמרים מומלץ לקרר",
        "יש לשקול הורדת שמרים",
        "בדיקת גיזוז - מומלץ לבדוק שמרים",
        "הורדת לחץ, שמרים תקינים",
    ];
    for (const note of falseNotes) {
        assert.equal(yeastDropAllowsCooling([{ id: "2026-10-27_1020", notes: note }], today), false, note);
    }
});

test("old completed notes, future entries and unsorted history are handled", () => {
    const notes = [
        { id: "2026-10-29_0845", notes: "הורדת 3 דליי שמרים" },
        { id: "2026-10-26_1020", notes: "הורדת 4 דליי שמרים" },
        { id: "2026-10-28_1150", notes: "בדיקת גיזוז" },
        { id: "2026-10-27_0830", notes: "הורדו שמרים" },
    ];
    assert.equal(latestCompletedYeastDropDate(notes, today), "2026-10-27");
    assert.equal(yeastDropAllowsCooling(notes, today), true);
});

test("live cooling recommendation checks completed drop timing before stable Plato", () => {
    const engine = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    assert.match(engine, /const coolingYeastReady = yeastDropAllowsCooling\(sortedMeasurements, todayDate\)/);
    assert.match(engine, /hasStablePlatoForCooling\(sortedMeasurements\)[\s\S]*stage\.name === "בתסיסה"[\s\S]*coolingYeastReady/);
    assert.match(engine, /Number\(lastMeasurement\.plato\) < 5 && coolingYeastReady/);
});

test("only dedicated quality-form preview may redirect the app root", () => {
    const main = read("../src/main.tsx");
    const hosting = read("../.github/workflows/firebase-hosting-pull-request.yml");
    assert.match(main, /VITE_DEPLOY_ENV === 'preview' && import\.meta\.env\.VITE_QUALITY_REPORT_ONLY_PREVIEW === 'true'/);
    assert.match(main, /location\.pathname === '\/'/);
    assert.match(hosting, /VITE_QUALITY_REPORT_ONLY_PREVIEW:.*pull_request\.number == 252/);
    assert.match(main, /import\('\.\/App'\)/);
});
