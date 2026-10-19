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
  ], "2026-10-18"), ["העלאת לחץ מ־0.8 ל־1.5"]);
});
test("supports multiple same-day actions and removes duplicates", () => {
  assert.deepEqual(yesterdayActionNotes([
    { id: "2026-10-18_0800", notes: "הפעלת קירור; כיוון פורק ל-1.4" },
    { id: "2026-10-18_1400", notes: "הפעלת קירור" },
  ], "2026-10-18"), ["המיכל קורר", "פורק כוון ל־1.4"]);
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
  ], "2026-10-18"), ["הורדת לחץ מ־1.7 ל־1", "לחץ אחרי שמרים 1.57", "המיכל נכנס למנוחת דיאציטיל"]);
});
