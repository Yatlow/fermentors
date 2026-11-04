import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const transpiled = ts.transpileModule(read("../src/SERVICES/cellering/carbonationPressureInsights.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { latestPressureReading, carbonationPressureContext, firstInRangePressureAdvice, subsequentCarbonationPressureAdvice, hasReachedCarbonationRange, livePressureReading, preferredPressureReading } =
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

test("first in-range milestone remains internal while operator sees current test status", () => {
    const engine = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    assert.match(engine, /בדיקת הגיזוז האחרונה תקינה/);
    assert.doesNotMatch(engine, /הגיזוז הגיע לראשונה לטווח התקין|בדיקת הגיזוז הראשונה בטווח התקין/);
    const earlierMeasurements = [
        carb("2026-10-25_0919", 2.29, 1.4),
        carb("2026-10-27_0823", 2.39, 1.15),
        carb("2026-10-28_0856", 2.48, 1.0),
    ];
    assert.equal(
        firstInRangePressureAdvice(earlierMeasurements, "2026-10-28", inRange)?.direction,
        "lower",
    );
});

test("pre-first-in-range phase permits a deliberate hold when all carbonation readings remain out of spec", () => {
    const history = [
        carb("2026-10-25_0900", 2.1, 0.4),
        carb("2026-10-27_0920", 2.35, 1.1),
        carb("2026-10-28_0830", 2.31, 0.7),
    ];
    assert.equal(hasReachedCarbonationRange(history, today, inRange), false);
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45), null);
    // The operator should be able to hold even below 0.9 bar; this is an
    // explicit choice, not an automatic instruction to alter head pressure.
    history[2].pressure = 1.2;
    assert.equal(hasReachedCarbonationRange(history, today, inRange), false);
});

test("a prior in-range measurement ends the pre-first phase permanently for that batch", () => {
    const history = [
        carb("2026-10-25_0800", 2.32, 0.5),
        carb("2026-10-26_0800", 2.45, 0.8),
        carb("2026-10-28_0800", 2.3, 0.8),
    ];
    assert.equal(hasReachedCarbonationRange(history, today, inRange), true);
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45)?.kind, "raise");
    history[2].pressure = 0.91;
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45)?.kind, "raise");
});

test("only real in-range dates up to today end the first-acceptable-carbonation phase", () => {
    assert.equal(hasReachedCarbonationRange([
        carb("2026-10-25_0800", "", 1.0),
        carb("2026-10-26_0840", null, 1.1),
        carb("2026-10-28_0910", 2.3, 0.9),
        carb("2026-10-29_0900", 2.45, 0.7),
    ], today, inRange), false);
    assert.equal(hasReachedCarbonationRange([
        carb("2026-10-27_0800", 2.45, 0.8),
        carb("2026-10-28_0855", 2.60, 1.1),
    ], today, inRange), true);
    assert.equal(hasReachedCarbonationRange([
        carb("2026-10-25_0845", 2.3, 1.1),
        carb("2026-10-28_1000", 2.44, 1.0),
    ], today, inRange), true);
});

test("an explicit hold resolves today's carbonation intervention without changing pressure", async () => {
    const actionSource = ts.transpileModule(read("../src/SERVICES/cellering/cellarActionState.ts"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const { hasCellarActionOnDate } = await import(
        "data:text/javascript;base64," + Buffer.from(actionSource).toString("base64")
    );
    const note = "השארת לחץ ללא שינוי לאחר בדיקת גיזוז";
    const history = [
        { id: "2026-10-27_1000", notes: note },
        { id: "2026-10-28_0810", carbonation: 2.3, pressure: 0.7, notes: "" },
    ];
    assert.equal(hasCellarActionOnDate(history, today, ["השארת לחץ ללא שינוי"]), false);
    history.push({ id: "2026-10-28_1240", notes: note });
    assert.equal(hasCellarActionOnDate(history, today, ["השארת לחץ ללא שינוי"]), true);
    assert.equal(hasCellarActionOnDate(history, today, ["העלאת לחץ", "הורדת לחץ"]), false);
});

test("before the first in-range carbonation reading, the existing generic rule stays in force", () => {
    const history = [
        carb("2026-10-25_0900", 2.1, 0.8),
        carb("2026-10-28_0900", 2.35, 1.0),
    ];
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45), null);
    assert.equal(firstInRangePressureAdvice(history, today, inRange), null);
});

test("first arrival in range stays a one-off event, subsequent in-range test does not create pressure work", () => {
    const first = [carb("2026-10-26_0900", 2.2, 0.9), carb("2026-10-28_0900", 2.45, 1.1)];
    assert.equal(firstInRangePressureAdvice(first, today, inRange)?.direction, "lower");
    assert.equal(subsequentCarbonationPressureAdvice(first, today, inRange, 2.45), null);
    assert.equal(firstInRangePressureAdvice([
        carb("2026-10-26_0900", 2.44, 0.5), carb("2026-10-28_0900", 2.45, 1.1),
    ], today, inRange), null);
});

test("the first in-range result remains eligible for an operational hold with either pressure direction", () => {
    const history = [carb("2026-10-25_0900", 2.30, 0.7), carb("2026-10-28_0900", 2.45, 0.91)];
    assert.equal(hasReachedCarbonationRange(history, today, inRange), true);
    assert.equal(firstInRangePressureAdvice(history, today, inRange)?.direction, "lower");
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45), null);
    history[1].pressure = 0.49;
    assert.equal(firstInRangePressureAdvice(history, today, inRange)?.direction, "raise");
    history[1].pressure = 0.7;
    assert.equal(firstInRangePressureAdvice(history, today, inRange), null,
        "with already acceptable pressure there is no correction recommendation to complete");
});

test("after a prior in-range result, high carbonation means lower pressure", () => {
    const history = [
        carb("2026-10-25_0900", 2.48, 0.8),
        carb("2026-10-28_0900", 2.60, 1.1),
    ];
    const result = subsequentCarbonationPressureAdvice(history, today, inRange, 2.45);
    assert.equal(result?.kind, "lower");
    assert.equal(result?.carbonation, 2.6);
});

test("after a prior in-range result, low carbonation with low head pressure means raise", () => {
    const history = [
        carb("2026-10-25_0900", 2.46, 0.8),
        carb("2026-10-28_0900", 2.30, 0.7),
    ];
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45)?.kind, "raise");
});

test("after the first in-range result, low carbonation always means raise even above 0.9 bar", () => {
    const history = [
        carb("2026-10-25_0900", 2.46, 1.0),
        carb("2026-10-28_0900", 2.3, 0.91),
    ];
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45)?.kind, "raise");
    history[1].pressure = 0.9;
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45)?.kind, "raise");
});

test("after first in-range result, missing current pressure does not create a hold option", () => {
    const history = [
        carb("2026-10-25_0900", 2.46, 1.0),
        carb("2026-10-28_0900", 2.3, null),
    ];
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45)?.kind, "raise");
});

test("fresh live pressure affects first-in-range advice but not post-milestone direction", () => {
    const history = [
        carb("2026-10-25_0800", 2.46, 0.7),
        carb("2026-10-28_0800", 2.30, 0.6),
    ];
    const live = livePressureReading({ pressure: 1.2, pressureUpdatedAt: "2026-10-28T10:30:00Z" });
    assert.equal(live?.value, 1.2);
    assert.equal(preferredPressureReading(history, today, live)?.value, 1.2);
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45, live)?.kind, "raise");
    // The original first-in-range rule also uses the latest physical pressure.
    assert.equal(firstInRangePressureAdvice([
        carb("2026-10-25_0800", 2.3, 0.9),
        carb("2026-10-28_0800", 2.45, 0.7),
    ], today, inRange, live)?.direction, "lower");
});

test("later lower live pressure supersedes a high morning reading", () => {
    const history = [carb("2026-10-25_0800", 2.46, 1.1), carb("2026-10-28_0800", 2.3, 1.1)];
    const live = livePressureReading({ pressure: 0.5, pressureUpdatedAt: "2026-10-28T12:30:00Z" });
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45, live)?.kind, "raise");
    assert.equal(preferredPressureReading(history, today, live)?.value, 0.5);
});

test("stale or invalid live tank pressure never overrides today's actual reading", () => {
    const history = [carb("2026-10-25_0800", 2.46, 0.7), carb("2026-10-28_0800", 2.3, 1.1)];
    assert.equal(livePressureReading({ pressure: 1.5 }), null);
    assert.equal(livePressureReading({ pressure: 1.5, pressureUpdatedAt: "bad" }), null);
    const yesterday = livePressureReading({ pressure: 0.4, pressureUpdatedAt: "2026-10-27T10:00:00Z" });
    assert.equal(preferredPressureReading(history, today, yesterday)?.value, 1.1);
    assert.equal(subsequentCarbonationPressureAdvice(history, today, inRange, 2.45, yesterday)?.kind, "raise");
});

test("milestone is per current batch, latest reading must be today and out of range", () => {
    assert.equal(subsequentCarbonationPressureAdvice([
        carb("2026-10-25_0900", 2.46, 1.2),
        carb("2026-10-27_0900", 2.3, 1.0),
    ], today, inRange, 2.45), null);
    assert.equal(subsequentCarbonationPressureAdvice([
        carb("2026-10-25_0900", 2.46, 1.2),
        carb("2026-10-28_0900", 2.48, 1.0),
    ], today, inRange, 2.45), null);
    assert.equal(subsequentCarbonationPressureAdvice([
        carb("2026-10-25_0900", 2.46, 1.2),
        carb("2026-10-28_0900", 2.3, 1.0),
    ], today, inRange, NaN), null);
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

test("account utility is a sibling of navigation and not part of the logo", () => {
    const app = read("../src/App.tsx");
    const brand = app.indexOf('className="header-brand-top"');
    const logo = app.indexOf('className="header-logo"', brand);
    const logoEnd = app.indexOf('</div>', logo);
    const nav = app.indexOf('className={`mobile-nav-shell', logoEnd);
    const account = app.indexOf('className="header-account-menu"', nav);
    const filters = app.indexOf('className="dashboard-filter-toolbar"', account);
    assert.ok(brand >= 0 && brand < logo && logo < logoEnd &&
        logoEnd < nav && nav < account && account < filters);
    assert.equal((app.match(/className="header-account-menu"/g) ?? []).length, 1);
    assert.ok(app.includes('className="header-account-trigger"'));
    assert.ok(app.includes('className="header-account-popover"'));
});

test("mobile centres the logo and puts profile popover above nav tiles", () => {
    const css = read("../src/App.css");
    const mobile = css.split("/* Mobile: the logo remains centred")[1]?.split("@media print")[0];
    assert.ok(mobile, "mobile rules must exist");
    assert.ok(mobile.includes("flex-direction: column !important"));
    assert.ok(mobile.includes("margin: 0 auto !important"));
    assert.ok(mobile.includes("order: 1 !important"));
    assert.ok(mobile.includes("z-index: var(--layer-nav)"));
    assert.ok(mobile.includes("z-index: calc(var(--layer-nav) + 20)"));
});

test("tablet and desktop align icon with nav but style it as a secondary utility", () => {
    const css = read("../src/App.css");
    const wide = css.split("/* Tablet and desktop:")[1]?.split("/* Mobile:")[0];
    assert.ok(wide, "tablet/desktop rules must exist");
    assert.ok(wide.includes("@media (min-width: 601px)"));
    assert.ok(wide.includes("margin-inline-start: auto"));
    assert.ok(wide.includes("border-inline-start: 1px solid #dbe4ef"));
    assert.ok(wide.includes("display: block !important"));
    assert.ok(css.includes("border-radius: 50%"));
    assert.ok(css.includes("background: #f1f5f9"));
    assert.ok(css.includes(".header-account-desktop-name { display: none; }"));
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
    assert.match(engine, /getCoolingPlatoStabilityEvidence\(sortedMeasurements\)/);
    assert.match(engine, /const coolingCandidate = stabilityEvidence !== null &&[\s\S]*stage\.name === "בתסיסה" &&[\s\S]*coolingYeastReady/);
    assert.match(engine, /const readyToCoolDown = coolingCandidate && !platoAboveFermentationEnd/);
    assert.match(engine, /!readyToCoolDown && todayPlato !== null/);
    assert.match(engine, /if \(todayPlato < 5 && coolingYeastReady && !platoAboveFermentationEnd\)/);
});

test("only dedicated quality-form preview may redirect the app root", () => {
    const main = read("../src/main.tsx");
    const hosting = read("../.github/workflows/firebase-hosting-pull-request.yml");
    assert.match(main, /VITE_DEPLOY_ENV === 'preview' && import\.meta\.env\.VITE_QUALITY_REPORT_ONLY_PREVIEW === 'true'/);
    assert.match(main, /location\.pathname === '\/'/);
    assert.match(hosting, /VITE_QUALITY_REPORT_ONLY_PREVIEW:.*pull_request\.number == 252/);
    assert.match(main, /import\('\.\/App'\)/);
});
