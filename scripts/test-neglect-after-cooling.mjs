import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../src/SERVICES/cellering/neglectAfterCooling.ts");
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { evaluateColdTankNeglect } = await import(
    "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
const at = (dateTime) => new Date(dateTime);
const cooling = (id, notes = "קירור מיכל ל0.3°") => ({ id, notes });
const yeast = (id, notes = "הורדת שמרים 4 דליים") => ({ id, notes });
const carb = (id, carbonation = 2.4) => ({ id, carbonation });

test("tank 17: cooled yesterday cannot be neglected because yeast was last recorded six days ago", () => {
    const rows = [
        yeast("2026-10-20_0805"),
        carb("2026-10-18_0950"),
        cooling("2026-10-25_0935"),
    ];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-26T10:05:00")), null);
});

test("last action before cooling never starts the five-day clock", () => {
    const rows = [yeast("2026-10-12_0755"), cooling("2026-10-25_0825")];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-26T10:05:00")), null);
});

test("the fifth day must start only after the actual cooling hour", () => {
    const rows = [yeast("2026-10-12_0900"), cooling("2026-10-20_0825")];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-25T08:24:00")), null);
    const result = evaluateColdTankNeglect(rows, at("2026-10-25T08:25:00"));
    assert.equal(result?.importance, 3, "no post-cooling action preserves urgent neglect");
    assert.match(result.reason, /המיכל מוזנח מ־20\/10\/2026 בשעה 08:25/);
    assert.match(result.reason, /הוא דורש תשומת לב/);
    assert.match(result.reason, /מומלץ לבדוק צורך בבדיקת גיזוז ובהורדת שמרים/);
});

test("a cold yeast drop resets the clock only after actual cooling", () => {
    const rows = [cooling("2026-10-15_0700"), yeast("2026-10-20_0805")];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-24T12:00:00")), null);
    const result = evaluateColdTankNeglect(rows, at("2026-10-25T08:05:00"));
    assert.equal(result?.importance, 2);
    assert.match(result.reason, /20\/10\/2026 בשעה 08:05/);
});

test("a carbonation test after cooling resets clock, and blank carbonation does not", () => {
    const rows = [cooling("2026-10-15_0900"), carb("2026-10-24_0930", 2.5)];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-26T10:05:00")), null);
    const blank = evaluateColdTankNeglect([cooling("2026-10-15_0900"), carb("2026-10-24_0930", "")], at("2026-10-26T10:05:00"));
    assert.equal(blank?.importance, 3);
    assert.match(blank.reason, /15\/10\/2026 בשעה 09:00/);
});

test("latest post-cooling action wins, not the earlier one", () => {
    const rows = [cooling("2026-10-10_0700"), yeast("2026-10-12_0720"), carb("2026-10-20_1123")];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-24T14:00:00")), null);
    assert.match(evaluateColdTankNeglect(rows, at("2026-10-25T11:23:00")).reason, /20\/10\/2026 בשעה 11:23/);
});

test("cooling again after a diacetyl rest resets the clock", () => {
    const rows = [
        cooling("2026-10-12_0800"),
        yeast("2026-10-17_0900"),
        cooling("2026-10-25_0915", "המיכל הוחזר לקירור"),
    ];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-26T10:05:00")), null);
});

test("ordinary cooling action variations are recognized", () => {
    const variants = ["קירור מיכל ל0.3°", "התחלת קירור", "המיכל הועבר לקירור", "חזרה לקירור", "החזרה לקירור"];
    for (const note of variants) {
        assert.equal(evaluateColdTankNeglect([cooling("2026-10-25_0710", note)], at("2026-10-26T10:05:00")), null, note);
        assert.ok(evaluateColdTankNeglect([cooling("2026-10-20_0710", note)], at("2026-10-26T10:05:00")), note);
    }
});

test("requests to cool and negative mentions of cooling are not real cooling", () => {
    for (const note of ["נא לבצע קירור היום", "מומלץ לבצע קירור", "בדיקת גיזוז 2.4, ללא קירור"]) {
        assert.equal(evaluateColdTankNeglect([cooling("2026-10-10_0700", note)], at("2026-10-26T10:05:00")), null, note);
    }
});

test("recommendations mentioning yeast do not count as a completed yeast drop", () => {
    const rows = [cooling("2026-10-10_0825"), yeast("2026-10-25_0800", "מומלץ לבצע הורדת שמרים")];
    assert.match(evaluateColdTankNeglect(rows, at("2026-10-26T10:05:00")).reason, /10\/10\/2026/);
});

test("the seven-day threshold escalates a cold tank with earlier post-cooling activity", () => {
    const rows = [cooling("2026-10-10_0825"), yeast("2026-10-17_0950")];
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-24T09:50:00"))?.importance, 2);
    assert.equal(evaluateColdTankNeglect(rows, at("2026-10-24T09:51:00"))?.importance, 3);
});

test("date-only measurements retain the date without an invented time", () => {
    const result = evaluateColdTankNeglect([cooling("2026-10-20")], at("2026-10-26T10:05:00"));
    assert.ok(result);
    assert.match(result.reason, /מוזנח מ־20\/10\/2026,/);
    assert.doesNotMatch(result.reason, /בשעה 00:00/);
});

test("separate legacy measurement time is used when id has only a date", () => {
    const result = evaluateColdTankNeglect([{ id: "2026-10-20", time: "8:25", notes: "קירור מיכל ל0.3°" }], at("2026-10-26T10:05:00"));
    assert.match(result.reason, /20\/10\/2026 בשעה 08:25/);
});

test("unpadded measurement ids and unsorted measurement history are handled", () => {
    const rows = [carb("2026-10-20_930"), cooling("2026-10-10_830"), yeast("2026-10-19_810")];
    const result = evaluateColdTankNeglect(rows, at("2026-10-26T10:05:00"));
    assert.match(result.reason, /20\/10\/2026 בשעה 09:30/);
});

test("missing, malformed and future cooling never produce neglect", () => {
    const now = at("2026-10-26T10:05:00");
    assert.equal(evaluateColdTankNeglect([], now), null);
    assert.equal(evaluateColdTankNeglect([cooling("2026-13-20_0900")], now), null);
    assert.equal(evaluateColdTankNeglect([cooling("2026-10-30_0900")], now), null);
});

test("the cellar pipeline keeps the weekday and cold-stage guards", () => {
    const recommendationSource = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    assert.match(recommendationSource, /const coldNeglect = stage\.name === "קר"/);
    assert.match(recommendationSource, /showColdNeglect = coldNeglect !== null && shouldShowNeglectedTank\(today\)/);
    assert.match(recommendationSource, /autoIgnoredReason: coldNeglect !== null/);
    assert.match(recommendationSource, /evaluateColdTankNeglect\(sortedMeasurements\)/);
    assert.doesNotMatch(recommendationSource, /daysSinceLastAction/);
});
