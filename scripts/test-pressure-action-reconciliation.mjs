import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const extractionSource = readFileSync("server/batchDataExtractionService.js", "utf8");
const quickReportSource = readFileSync("src/components/dashboard/QuickTankReportBox.tsx", "utf8");
const syncSource = readFileSync("server/fermentor-cycle-optimization.js", "utf8");

const context = {
  parseIsraeliDate(value) {
    const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    return date.getDate() === Number(match[1]) ? date : null;
  },
};
vm.createContext(context);
vm.runInContext(extractionSource, context, { filename: "batchDataExtractionService.js" });

const reported = context.extractReportedTankPressure_;
const fromSheet = context.sheetTankPressure_;

for (const [note, expected] of [
  ["הורדת 2 דליי שמרים, לחץ אחרי 1.25 bar", 1.25],
  ["הורדת שמרים, לחץ אחרי הורדת שמרים: 1,3 bar", 1.3],
  ["העלאת לחץ ל: 1.6 bar", 1.6],
  ["הורדת לחץ ל-0.9 bar", 0.9],
  ["הורדת לחץ מ־1.6 ל־1.2 bar", 1.2],
  ["הורדת לחץ ל0.2 bar. תחילת גיזוז מלמטה בשעה 09:00", 0.2],
  ["סגירת גיזוז מלמטה בשעה 10:30 על 1.4 bar.", 1.4],
  ["הורדת 40 בקבוקים | הורדת לחץ ל-0.7", 0.7],
  ["העלאת לחץ ל: 1.1 bar | הורדת 2 דליי שמרים, לחץ אחרי 0.8 bar", 0.8],
  ["הורדת שמרים | העלאת לחץ ל: 0 bar", 0],
  ["כיוון פורק ל: 1.6 bar", null],
  ["סגירת נשם, כיוון פורק ל 1.5", null],
  ["דרייהופ, סגירת לחץ, כיוון פורק ל 1.6", null],
  ["הורדת 2 דליי שמרים, ללא דיווח לחץ", null],
  ["חימום מיכל ל14° למנוחת דיאצטיל", null],
]) {
  assert.equal(reported(note), expected, `action: ${note}`);
}

assert.equal(fromSheet("1.75Bar", "הורדת לחץ ל: 0.8 bar"), 1.75, "later explicit reading wins over stale notes");
assert.equal(fromSheet("0.00Bar", "העלאת לחץ ל: 1.1 bar"), 0, "zero is a legitimate explicit pressure");
assert.equal(fromSheet("", "העלאת לחץ ל: 1.1 bar"), 1.1, "note-only legacy report is recovered");
assert.equal(fromSheet("", "כיוון פורק ל: 1.6 bar"), null, "PRV setting is not tank pressure");

const header = ["תאריך", "שעה", "סוכר", "טמפרטורה", "לחץ", "pH", "גיזוז", "הערות"];
const row = (date, pressure, notes) => [date, "09:00", "", "", pressure, "", "", notes];
const recovered = context.findLatestAvailableMeasurements([
  header,
  row("28/10/2026", "1.6Bar", ""),
  row("29/10/2026", "", "הורדת 3 דליי שמרים, לחץ אחרי 1.1 bar"),
]);
assert.equal(recovered.pressure, 1.1, "newer note-only action advances currentData.pressure");

const preservesRecent = context.findLatestAvailableMeasurements([
  header,
  row("28/10/2026", "", "הורדת לחץ ל: 0.7 bar"),
  row("29/10/2026", "1.3Bar", ""),
]);
assert.equal(preservesRecent.pressure, 1.3, "older action must not override later numeric pressure");

const sameDay = context.findLatestAvailableMeasurements([
  header,
  row("29/10/2026", "1.1Bar", ""),
  row("29/10/2026", "1.2Bar", ""),
]);
assert.equal(sameDay.pressure, 1.2, "later Sheet row wins within the same day");

assert.match(quickReportSource, /noteType === "לחץ" \|\| noteType === "שמרים"/);
assert.match(quickReportSource, /noteType === "שמרים" \? value2 : value/);
assert.match(quickReportSource, /reading\.pressure = reportedPressure/);
assert.match(quickReportSource, /!Number\.isFinite\(reportedPressure\) \|\| reportedPressure < 0/);
assert.equal((syncSource.match(/sheetTankPressure_\(values\[r\]\[4\], values\[r\]\[7\]\)/g) || []).length, 2,
  "regular cycle and latest-measurement reconciliation must use legacy fallback");
assert.match(extractionSource, /pressure: sheetTankPressure_\(values\[r\]\[4\], values\[r\]\[7\]\)/,
  "historical measurements must use the same pressure resolution");

console.log("Pressure action and reconciliation regressions passed.");
