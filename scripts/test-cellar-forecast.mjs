import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// Compile the pure TypeScript forecast modules without bundling Firebase/React.
// Follow type-erased relative imports recursively so these tests run with the
// repository's normal Node test command on CI.
const cache = new Map();
function moduleDataUrl(file) {
    const absolute = resolve(file);
    if (cache.has(absolute)) return cache.get(absolute);
    const source = readFileSync(absolute, "utf8");
    let compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    compiled = compiled.replace(/from\s+["'](\.[^"']+)["']/g, (_match, relative) => {
        const target = resolve(dirname(absolute), relative + (relative.endsWith(".ts") ? "" : ".ts"));
        return "from " + JSON.stringify(moduleDataUrl(target));
    });
    const url = "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
    cache.set(absolute, url);
    return url;
}
const dir = resolve("src/SERVICES/cellering");
const { projectCarbonationRetest, projectNonHoppyWarmYeast } =
    await import(moduleDataUrl(resolve(dir, "actionForecast.ts")));
const { forecastRoutinesForDate, anticipatedColdTanksForSunday } =
    await import(moduleDataUrl(resolve(dir, "forecastRoutines.ts")));
const { summarizeCellaringForecastDay, conditionalForecastKind, conciseForecastTitle } =
    await import(moduleDataUrl(resolve(dir, "forecastPresentation.ts")));
const { projectKnownYeastCompletions } =
    await import(moduleDataUrl(resolve(dir, "yeastCompletionForecast.ts")));
const { projectPlatoThresholdRecheck } =
    await import(moduleDataUrl(resolve(dir, "platoThresholdForecast.ts")));

const specs = {
    carbonation: { ipa: 2.45, "חיטה": 2.5, "לאגר": 2.5, other: 2.45 },
    tolorances: { carbonation: 0.04, shutTankMinPlato: 5, yeastDropMinPlato: 6, yeastDropMinPlatoLager: 6 },
};
const cold = { id: "11", tankNumber: 11, beerStyle: "IPA", stage: { name: "קר" } };
const warm = { id: "4", tankNumber: 4, beerStyle: "חיטה", stage: { name: "בתסיסה" }, brewDate: "01/11/2026" };
const retest = (history, today = "2026-11-03", tank = cold, custom = specs) =>
    projectCarbonationRetest(tank, history, today, custom);
const nonHoppy = (history, today = "2026-11-03", tank = warm) =>
    projectNonHoppyWarmYeast(tank, history, today, specs);

test("pressure correction sets retest two calendar days later, not 48 hours", () => {
    const rows = [{ id: "2026-11-03_0830", carbonation: 2.2 }, { id: "2026-11-03_2359", notes: "העלאת לחץ ל1.6 bar" }];
    assert.equal(retest(rows)[0]?.dueDate, "2026-11-05");
    assert.match(retest(rows)[0]?.basis, /לאחר שינוי לחץ/);
});

test("bottom carbonation retest is next day after closure", () => {
    const rows = [
        { id: "2026-11-03_0830", carbonation: 2.2 },
        { id: "2026-11-03_1400", notes: "סגירת גיזוז מלמטה בשעה 14:00 על 0.8 bar" },
    ];
    assert.equal(retest(rows)[0]?.dueDate, "2026-11-04");
});

test("failed test without treatment produces one retest two days later", () => {
    const rows = [{ id: "2026-11-03_0900", carbonation: 2.2 }];
    const result = retest(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].dueDate, "2026-11-05");
    assert.match(result[0].title, /גיזוז חוזרת/);
});

test("normal last test, currently actionable retest and non-cold tank produce no future work", () => {
    assert.deepEqual(retest([{ id: "2026-11-03_0900", carbonation: 2.45 }]), []);
    assert.deepEqual(retest([{ id: "2026-11-01_0900", carbonation: 2.2 }]), []);
    assert.deepEqual(retest([{ id: "2026-11-03_0900", carbonation: 2.2 }], "2026-11-03", warm), []);
    assert.deepEqual(retest([{ id: "2026-11-04_0900", carbonation: 2.2 }]), []);
});

test("Friday moderate retest is deferred to Sunday; urgent test stays Friday", () => {
    const moderate = [{ id: "2026-10-28_0900", carbonation: 2.39, notes: "הורדת לחץ ל1.2 bar" }];
    const important = [{ id: "2026-10-28_0900", carbonation: 2.2, notes: "הורדת לחץ ל1.2 bar" }];
    assert.equal(retest(moderate, "2026-10-29")[0]?.dueDate, "2026-11-01");
    assert.equal(retest(important, "2026-10-29")[0]?.dueDate, "2026-10-30");
});

test("Saturday retest is shown on Sunday, latest actual test resets its clock", () => {
    const history = [{ id: "2026-10-30_0900", carbonation: 2.2 }];
    assert.equal(retest(history, "2026-10-30")[0]?.dueDate, "2026-11-01");
    const changed = [...history, { id: "2026-10-30_1100", carbonation: 2.45 }];
    assert.deepEqual(retest(changed, "2026-10-30"), []);
});

test("Sunday routines are two explicit actions per cold tank, never CLT or warm tanks", () => {
    const rows = forecastRoutinesForDate({
        date: "2026-11-08", weekday: 0, coldTankNumbers: ["11", "19"],
        nextWeekPackagingTankNumbers: [], scheduled: [], conditional: [],
    });
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((item) => item.actionType === "carbTest").length, 2);
    assert.equal(rows.filter((item) => item.actionType === "yeastDrop").length, 2);
    assert.ok(rows.every((item) => item.source === "sunday"));
});

test("Sunday does not duplicate explicitly scheduled or already predicted actions", () => {
    const rows = forecastRoutinesForDate({
        date: "2026-11-08", weekday: 0, coldTankNumbers: ["11"], nextWeekPackagingTankNumbers: [],
        scheduled: [{ tankNumber: "11", actionType: "yeastDrop" }],
        conditional: [{ id: "11:carb-retest:2026-11-08", tankNumber: "11",
            dueDate: "2026-11-08", title: "בדיקת גיזוז חוזרת", basis: "" }],
    });
    assert.deepEqual(rows, []);
});

test("Wednesday/Thursday packaging routines retain their tank and stage filters", () => {
    const input = { date: "2026-11-04", weekday: 3,
        coldTankNumbers: ["11"], nextWeekPackagingTankNumbers: ["11", "19"], scheduled: [], conditional: [] };
    assert.deepEqual(forecastRoutinesForDate(input).map((row) => row.tankNumber), ["11"]);
    const thursday = forecastRoutinesForDate({ ...input, weekday: 4 });
    assert.deepEqual(thursday.map((row) => row.tankNumber), ["11", "19"]);
});

test("non-hoppy warm yeast check requires tank closure, fresh Plato and brewing age", () => {
    const rows = [
        { id: "2026-11-02_0800", plato: 5.6, notes: "סגירת נשם, כיוון פורק 1.4" },
        { id: "2026-11-03_0800", plato: 5.3 },
    ];
    const result = nonHoppy(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].dueDate, "2026-11-06");
    assert.match(result[0].title, /צפי להורדת שמרים חמה/);
    assert.deepEqual(nonHoppy(rows.slice(1)), []);
    assert.deepEqual(nonHoppy([...rows, { id: "2026-11-03_0900", notes: "הורדת שמרים 2 דליים" }]), []);
});

test("non-hoppy yeast forecast uses future Plato crossing as a check, not an action", () => {
    const rows = [
        { id: "2026-11-02_0900", plato: 8, notes: "סגירת לחץ" },
        { id: "2026-11-03_0900", plato: 7 },
    ];
    assert.equal(nonHoppy(rows)[0]?.dueDate, "2026-11-06");
    assert.deepEqual(nonHoppy(rows, "2026-11-03", { ...warm, beerStyle: "IPA" }), []);
    assert.deepEqual(nonHoppy(rows, "2026-11-03", { ...warm, dryHopRequired: true, dryHopTargetPlato: 6 }), []);
    assert.deepEqual(nonHoppy(rows, "2026-11-03", { ...warm, brewDate: "not a date" }), []);
});

test("stale or missing warm yeast measurements never predict readiness", () => {
    assert.deepEqual(nonHoppy([
        { id: "2026-10-25_0800", plato: 8, notes: "סגירת נשם" },
        { id: "2026-10-26_0800", plato: 7 },
    ]), []);
    assert.deepEqual(nonHoppy([
        { id: "2026-11-02_0800", plato: 8 },
        { id: "2026-11-03_0800", plato: 7 },
    ]), []);
});

test("existing yeast completion and Plato projections remain available", () => {
    const completion = projectKnownYeastCompletions({ ...cold, stage: { name: "קר" } }, [
        { id: "2026-11-01_0800", notes: "קירור מיכל ל4°", temp: 4 },
        { id: "2026-11-02_0800", notes: "הורדת שמרים 4 דליים", temp: 4 },
    ], "2026-11-03", {});
    assert.equal(completion[0]?.dueDate, "2026-11-04");
    assert.match(completion[0]?.title ?? "", /השלמת הורדת שמרים/);
    const hop = projectPlatoThresholdRecheck({ ...warm, beerStyle: "IPA" }, [
        { id: "2026-11-02_0800", plato: 10 },
        { id: "2026-11-03_0800", plato: 9 },
    ], "2026-11-03", specs);
    assert.match(hop[0]?.title ?? "", /צפי לדרייהופ/);
    const close = projectPlatoThresholdRecheck(warm, [
        { id: "2026-11-02_0800", plato: 7 },
        { id: "2026-11-03_0800", plato: 6 },
    ], "2026-11-03", specs);
    assert.match(close[0]?.title ?? "", /צפי לסגירת מיכל/);
});

test("forecast component wires all five requested capabilities", () => {
    const source = readFileSync(resolve("src/components/cellering/CellaringForecast.tsx"), "utf8");
    for (const name of ["projectCarbonationRetest", "projectNonHoppyWarmYeast",
        "projectKnownYeastCompletions", "projectHybridFermentationMilestones", "forecastRoutinesForDate"]) {
        assert.match(source, new RegExp(name + "\\("));
    }
});

test("Sunday also includes warm tanks with committed cooling before Sunday as conditional work", () => {
    const projected = anticipatedColdTanksForSunday({
        today: "2026-11-04", sunday: "2026-11-08",
        tanks: [
            { tankNumber: 11, batchNumber: "#1610", stage: { name: "בתסיסה" } },
            { tankNumber: 12, batchNumber: "1611", stage: { name: "בתסיסה" } },
        ],
        scheduled: [
            { tankNumber: "11", batchNumber: "1610", actionType: "coolDown", dueDate: "2026-11-06" },
            { tankNumber: "12", batchNumber: "1610", actionType: "coolDown", dueDate: "2026-11-06" },
        ],
        conditional: [],
    });
    assert.deepEqual(projected, ["11"]);
    const routines = forecastRoutinesForDate({
        date: "2026-11-08", weekday: 0,
        coldTankNumbers: ["9"], anticipatedColdTankNumbers: projected,
        nextWeekPackagingTankNumbers: [], scheduled: [], conditional: [],
    });
    assert.equal(routines.length, 4);
    assert.deepEqual(routines.filter((row) => row.tankNumber === "11").map((row) => row.source),
        ["sunday-predicted-cold", "sunday-predicted-cold"]);
    assert.deepEqual(routines.filter((row) => row.tankNumber === "9").map((row) => row.source),
        ["sunday", "sunday"]);
});

test("cooling readiness can suggest Sunday work but does not claim that cooling occurred", () => {
    const conditional = [{
        id: "17:cooling-readiness:2026-11-07",
        tankNumber: "17", dueDate: "2026-11-07", title: "צפי לבדיקת מוכנות לקירור", basis: "",
    }];
    const projected = anticipatedColdTanksForSunday({
        today: "2026-11-04", sunday: "2026-11-08",
        tanks: [{ tankNumber: 17, batchNumber: "1617", stage: { name: "בתסיסה" } }],
        scheduled: [], conditional,
    });
    assert.deepEqual(projected, ["17"]);
    assert.deepEqual(anticipatedColdTanksForSunday({
        today: "2026-11-04", sunday: "2026-11-08",
        tanks: [{ tankNumber: 17, batchNumber: "1617", stage: { name: "בתסיסה" } }],
        scheduled: [], conditional: [{ ...conditional[0], dueDate: "2026-11-08" }],
    }), []);
});

test("a same-day, stale or unrelated cooling plan cannot invent Sunday cold tank actions", () => {
    const tank = { tankNumber: 17, batchNumber: "1617", stage: { name: "בתסיסה" } };
    for (const dueDate of ["2026-11-03", "2026-11-08", "2026-11-09"]) {
        assert.deepEqual(anticipatedColdTanksForSunday({
            today: "2026-11-04", sunday: "2026-11-08", tanks: [tank],
            scheduled: [{ tankNumber: "17", batchNumber: "1617", actionType: "coolDown", dueDate }],
            conditional: [],
        }), []);
    }
    assert.deepEqual(anticipatedColdTanksForSunday({
        today: "2026-11-04", sunday: "2026-11-08", tanks: [{ ...tank, stage: { name: "קר" } }],
        scheduled: [{ tankNumber: "17", batchNumber: "1617", actionType: "coolDown", dueDate: "2026-11-05" }],
        conditional: [],
    }), []);
});

test("Sunday conditional work deduplicates against planned work and known cold tanks", () => {
    const result = forecastRoutinesForDate({
        date: "2026-11-08", weekday: 0,
        coldTankNumbers: ["11"], anticipatedColdTankNumbers: ["11", "17"],
        nextWeekPackagingTankNumbers: [],
        scheduled: [{ tankNumber: "17", actionType: "carbTest" }],
        conditional: [{ id: "17:yeast:2026-11-08", tankNumber: "17", dueDate: "2026-11-08",
            title: "השלמת הורדת שמרים", basis: "" }],
    });
    assert.deepEqual(result.map((row) => row.tankNumber), ["11", "11"]);
});

test("scheduled 'other' notes are displayed, including long free-form instructions", () => {
    const source = readFileSync(resolve("src/components/cellering/CellaringForecast.tsx"), "utf8");
    assert.match(source, /item\.note\?\.trim\(\)/);
    assert.match(source, /item\.actionType === "other"/);
    assert.match(source, /cellar-forecast-scheduled-note/);
    assert.match(source, /מותנה בקירור/);
});

test("daily executive summary groups the exact forecast rows by action, not by badge source", () => {
    const day = summarizeCellaringForecastDay({
        scheduledRows: [
            { actionType: "carbTest" }, { actionType: "yeastDrop" }, { actionType: "other" },
        ],
        conditionalRows: [
            { id: "9:plato-recheck:2026-11-06", title: "צפי לדרייהופ — בדיקת תנאים" },
            { id: "11:carb-retest:2026-11-06", title: "בדיקת גיזוז חוזרת" },
            { id: "19:cooling-readiness:2026-11-06", title: "צפי לבדיקת מוכנות לקירור" },
        ],
        routines: [
            { actionType: "carbTest", source: "sunday" },
            { actionType: "yeastDrop", source: "sunday-predicted-cold" },
        ],
    });
    assert.equal(day.total, 8);
    assert.equal(day.conditionalCount, 4, "predicted cold Sunday work is conditional too");
    assert.deepEqual(day.groups.map((g) => [g.kind, g.count]), [
        ["carbTest", 3], ["yeastDrop", 2], ["dryHop", 1],
        ["coolDown", 1], ["other", 1],
    ]);
    assert.equal(day.groups[0].label, "בדיקות גיזוז");
});

test("forecast categories keep tests, dry-hop projections and carbonating from below separate", () => {
    assert.equal(conditionalForecastKind({ id: "a", title: "צפי לדרייהופ — בדיקת תנאים" }), "dryHop");
    assert.equal(conditionalForecastKind({ id: "b", title: "בדיקת גיזוז חוזרת" }), "carbTest");
    assert.equal(conditionalForecastKind({ id: "c", title: "מנוחת דיאצטיל" }), "diacetyl");
    assert.equal(conditionalForecastKind({ id: "d", title: "גיזוז מלמטה" }), "bottomCarbonation");
    assert.equal(conciseForecastTitle("צפי לדרייהופ — בדיקת תנאים"), "בדיקת תנאים: דרייהופ");
    assert.equal(conciseForecastTitle("בדיקת גיזוז חוזרת"), "בדיקת גיזוז חוזרת");
});

test("forecast accordion defaults to concise daily rows while retaining explanations and free-form work", () => {
    const source = readFileSync(resolve("src/components/cellering/CellaringForecast.tsx"), "utf8");
    assert.match(source, /expandedDays, setExpandedDays\] = useState<Set<string>>\(\(\) => new Set\(\)\)/);
    assert.match(source, /aria-expanded=\{isDayExpanded\}/);
    assert.match(source, /aria-controls=\{detailsId\}/);
    assert.match(source, /summary\.groups\.map\(/);
    assert.match(source, /summary\.conditionalCount > 0/);
    assert.match(source, /isDayExpanded && <div id=\{detailsId\}/);
    assert.match(source, /<summary>למה\?<\/summary>/);
    assert.match(source, /item\.actionType === "other"/);
    assert.match(source, /cellar-forecast-scheduled-note/);
    assert.match(source, /item\.basis/);
    assert.match(source, /מותנה בקירור/);
});
