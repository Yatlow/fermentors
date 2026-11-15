import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataModule = (source) => "data:text/javascript;base64," + Buffer.from(compile(source)).toString("base64");

const coolingModule = dataModule(read("../src/SERVICES/cellering/neglectAfterCooling.ts"));
const fermentationEndModule = dataModule(read("../src/SERVICES/cellering/fermentationEndPlato.ts"));
const source = read("../src/SERVICES/cellering/warmFermentationTest.ts")
    .replace('from "./neglectAfterCooling"', 'from "' + coolingModule + '"')
    .replace('from "./fermentationEndPlato"', 'from "' + fermentationEndModule + '"');
const {
    parseWarmPlato, coolingPlatoAtRecordedCooling,
    warmPlatoDifference, warmTestWarning, warmTestBlocksCooling, normalizeWarmBatch, getWarmFermentationGapThreshold
} = await import(dataModule(source));

test("incubator result is numeric, bounded and supports local decimal commas", () => {
    assert.equal(parseWarmPlato("2,6"), 2.6);
    assert.equal(parseWarmPlato("0"), 0);
    assert.equal(parseWarmPlato("40"), 40);
    for (const invalid of ["", "-1", "41", "2abc", "NaN"]) {
        assert.equal(parseWarmPlato(invalid), null, invalid);
    }
    assert.equal(normalizeWarmBatch("#1604"), "1604");
});

test("cooling comparison uses real cooling and the last earlier numeric reading", () => {
    const measurements = [
        { id: "2026-11-01_0800", plato: 4.3, notes: "" },
        { id: "2026-11-02_0800", plato: 3.9, notes: "" },
        { id: "2026-11-02_1600", plato: null, notes: "קירור מיכל ל־0.3 מעלות" },
        { id: "2026-11-03_0800", plato: 3.6, notes: "בעקבות הקירור עשינו בדיקה" },
    ];
    assert.equal(coolingPlatoAtRecordedCooling(measurements), 3.9);
    assert.equal(coolingPlatoAtRecordedCooling([{ id: "2026-11-01_0800", plato: 3 }]), null);
});

test("warnings are advisory, stage-specific and never compute a carbonation setpoint", () => {
    assert.equal(warmPlatoDifference(3.1, 3.1), null);
    assert.equal(warmPlatoDifference(2.8, 3.1), 0.3);
    assert.equal(warmTestWarning({ packaged: false, isCold: false, testPlato: 3, coolingPlato: 3 }), null);
    assert.match(warmTestWarning({ packaged: true, isCold: false, testPlato: 2.8, coolingPlato: 3.1 }), /כבר נארזה/);
    assert.match(warmTestWarning({ packaged: false, isCold: true, testPlato: 2.8, coolingPlato: 3.1 }), /יעד הגיזוז/);
});

test("default 0.1 Plato gap is inclusive, adjustable via cellar specs and is independent of cooling", async () => {
    assert.equal(getWarmFermentationGapThreshold(null), 0.1);
    assert.equal(getWarmFermentationGapThreshold({ tolorances: {} }), 0.1);
    assert.equal(getWarmFermentationGapThreshold({ tolorances: { warmFermentationPlatoDelta: 0.2 } }), 0.2);
    assert.equal(getWarmFermentationGapThreshold({ tolorances: { warmFermentationPlatoDelta: -1 } }), 0.1);
    const params = { packaged: false, isCold: true, coolingPlato: 3.0 };
    assert.equal(warmTestWarning({ ...params, testPlato: 2.91, threshold: 0.1 }), null, "0.09P should be below threshold");
    assert.match(warmTestWarning({ ...params, testPlato: 2.9, threshold: 0.1 }), /יעד הגיזוז/, "0.10P is at threshold");
    assert.equal(warmTestWarning({ ...params, testPlato: 2.8, threshold: 0.3 }), null, "updated spec applies");
    assert.match(warmTestWarning({ ...params, testPlato: 2.8, threshold: 0.2 }), /יעד הגיזוז/);
    const specModule = await import(fermentationEndModule);
    assert.equal(specModule.withCellarSpecDefaults({}).tolorances.warmFermentationPlatoDelta, 0.1);
    assert.equal(specModule.withCellarSpecDefaults({ tolorances: { warmFermentationPlatoDelta: 0.15 } }).tolorances.warmFermentationPlatoDelta, 0.15);
    const UI = read("../src/components/tools/EditSpecs.tsx");
    assert.match(UI, /warmFermentationPlatoDelta:"סף פער בבדיקת תסיסה חמה/);
    const store = read("../src/SERVICES/cellering/warmFermentationTestStore.ts");
    assert.doesNotMatch(store, /recordedBy:/, "No dedicated tester attribution should be stored");
});

test("hot-tank cooling requires actual tank Plato at or below the incubator value", () => {
    assert.equal(warmTestBlocksCooling("בתסיסה", 3.31, 3.3), true);
    assert.equal(warmTestBlocksCooling("בתסיסה", 3.3, 3.3), false);
    assert.equal(warmTestBlocksCooling("בתסיסה", 3.1, 3.3), false);
    assert.equal(warmTestBlocksCooling("קר", 4, 3), false);
    assert.equal(warmTestBlocksCooling("בתסיסה", null, 3), false);
    const engine = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    assert.match(engine, /warmTestCoolingBlocked = warmTestBlocksCooling/);
    assert.match(engine, /readyToCoolDown = coolingCandidate && !platoAboveFermentationEnd && !warmTestCoolingBlocked/);
    assert.match(engine, /reviewOnly: coolingReviewOnly \|\| warmTestReviewOnly/);
});

test("packaged test adds its own dated row without populating the daily sugar field; retry is idempotent", () => {
    const rows = [
        ["תאריך", "שעה", "סוכר", "טמפרטורה", "לחץ", "pH", "גיזוז", "הערות"],
        ["14/11/2026", "08:00", 3.4, 12, 0.1, 4.3, "", "מדידה שגרתית"],
        ["", "", "", "", "", "", "", ""],
        ["סיכום", "", "", "", "", "", "", ""],
    ];
    const sheet = {
        getLastRow: () => rows.length,
        getMaxRows: () => rows.length,
        getRange(row, col, count = 1, width = 1) {
            return {
                getDisplayValues: () => Array.from({ length: count }, (_, i) =>
                    rows[row - 1 + i].slice(col - 1, col - 1 + width).map(String)),
                setValues: (values) => values.forEach((a, i) => a.forEach((v, j) => { rows[row - 1 + i][col - 1 + j] = v; })),
                setNumberFormats: () => {},
            };
        },
        insertRowsBefore: (row, count) => { rows.splice(row - 1, 0, ...Array.from({ length: count }, () => Array(8).fill(""))); },
        insertRowsAfter: (_row, count) => { for (let i = 0; i < count; i++) rows.push(Array(8).fill("")); },
    };
    const ctx = {
        isFinite, Date, String, Number, Error,
        SpreadsheetApp: { openById: () => ({ getSheets: () => [sheet] }) },
        LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
        Utilities: { formatDate: (_date, _zone, format) => format === "dd/MM/yyyy" ? "15/11/2026" : "10:12" },
        extractSpreadsheetId: () => "sheet1",
        getCachedFermentationHeaderRow_: () => 1,
        parseIsraeliDate: (v) => /^\d\d\/\d\d\/\d{4}$/.test(v),
        addFermentationNoteFast_: () => { throw Error("Must not use fast note merge after packaging"); },
    };
    runInNewContext(read("../server/warmFermentationTest.js"), ctx);
    const input = {
        batchNumber: "1604", plato: 2.7, recordedAt: "2026-11-15T08:12:00Z",
        sheetUrl: "https://docs.google.com/spreadsheets/d/sheet1/edit", packaged: true, inTank: false,
    };
    const first = ctx.appendWarmFermentationTest_(input, "same-request");
    assert.equal(first.row, 3);
    assert.equal(rows[1][2], 3.4);
    assert.deepEqual(rows[2].slice(0, 3), ["15/11/2026", "10:12", ""]);
    assert.equal(rows[2][7], "בדיקת תסיסה חמה לאחר אריזה 2.7°P");
    const duplicate = ctx.appendWarmFermentationTest_(input, "same-request");
    assert.equal(duplicate.duplicate, true);
    assert.equal(rows[3][0], "סיכום");
});

test("app, Firestore, retry worker and recording entrypoint all support the same new action", () => {
    const app = read("../src/App.tsx");
    assert.match(app, /<WarmFermentationTest brews=\{brews\}/);
    assert.match(read("../src/SERVICES/cellering/warmFermentationTestStore.ts"), /action: "addWarmFermentationTest"/);
    assert.match(read("../server/post.js"), /appendWarmFermentationTest_\(data.test/);
    assert.match(read("../server/sheetSyncOutbox.js"), /sheetSyncWarmTestPayload_/);
    assert.match(read("../firestore.rules"), /match \/warmFermentationTests\/\{testId\}/);
    assert.match(read("../src/components/cellering/WarmFermentationTest.tsx"), /50 - collected.length/);
});
