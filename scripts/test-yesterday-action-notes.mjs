import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/cellering/yesterdayActionNotes.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { yesterdayActionNotes } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("shows only actions documented on the preceding calendar day", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-17_1100", notes: "העלאת לחץ ל-1.5" },
    { id: "2026-10-18_0900", notes: "העלאת לחץ מ-0.8 ל-1.5" },
    { id: "2026-10-19_0800", notes: "הורדת לחץ ל-1" },
  ], "2026-10-18"), ["העלאת לחץ: מ־0.8 ל־1.5 bar"]);
});
test("supports multiple same-day actions and removes duplicates", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "הפעלת קירור; כיוון פורק ל-1.4" },
    { id: "2026-10-18_1400", notes: "הפעלת קירור" },
  ], "2026-10-18"), ["קירור: המיכל הועבר לקירור", "כיוון פורק: ל־1.4 bar"]);
});
test("does not mistake recommendations for executed actions", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "מומלץ לבצע הורדת לחץ" },
    { id: "2026-10-18_0900", notes: "מחר יש לבצע מנוחת דיאצטיל" },
    { id: "2026-10-18_1000", notes: "לא בוצע קירור" },
  ], "2026-10-18"), []);
});
test("excludes rows with no action note", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", temp: 9, pressure: 0.8 },
  ], "2026-10-18"), []);
});

test("summarizes pressure decrease, yeast pressure and diacetyl rest", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_1000", notes: "הורדת לחץ מ-1.7 ל-1; הורדת שמרים, לחץ אחרי שמרים 1.57; כיבוי קירור למנוחת דיאצטיל" },
  ], "2026-10-18"), ["הורדת לחץ: מ־1.7 ל־1 bar", "הורדת שמרים: לחץ אחרי הורדת שמרים 1.57 bar", "מנוחת דיאצטיל: המיכל הועבר למנוחת דיאצטיל"]);
});

test("records completed pressure-relevant valve and vent adjustments", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "כיוון פורק ל-1.6; נסגר נשם" },
  ], "2026-10-18"), ["כיוון פורק: ל־1.6 bar", "סגירת נשם: הנשם נסגר"]);
});
test("recognizes resuming cooling after diacetyl rest", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "סיום מנוחת דיאצטיל, חזרה לקירור" },
  ], "2026-10-18"), ["חזרה לקירור: המיכל הוחזר לקירור"]);
});

test("parses actual dashboard action note formats with recorded pressure values", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "הורדת לחץ ל: 1.5 bar; סגירת נשם, כיוון פורק ל 1.5; הורדת 2 דליי שמרים, לחץ אחרי 0.7 bar" },
  ], "2026-10-18"), [
    "הורדת לחץ: ל־1.5 bar",
    "סגירת נשם: הנשם נסגר",
    "כיוון פורק: ל־1.5 bar",
    "הורדת שמרים: לחץ אחרי הורדת שמרים 0.7 bar",
  ]);
});
test("parses actual quick-action cooling and diacetyl notes", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "קירור מיכל ל0.3°; חימום מיכל ל14° למנוחת דיאציטיל" },
  ], "2026-10-18"), [
    "קירור: המיכל הועבר לקירור",
    "מנוחת דיאצטיל: המיכל הועבר למנוחת דיאצטיל",
  ]);
});
test("displays target when no starting pressure exists, not a guessed before-value", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "העלאת לחץ ל: 1.6 bar" },
  ], "2026-10-18"), ["העלאת לחץ: ל־1.6 bar"]);
});
