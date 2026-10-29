import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const extraction = readFileSync("server/batchDataExtractionService.js", "utf8");
const quick = readFileSync("src/components/dashboard/QuickTankReportBox.tsx", "utf8");
const writer = readFileSync("src/SERVICES/getAndPost/pushCurrentDataToFirestore.ts", "utf8");
const sync = readFileSync("server/fermentor-cycle-optimization.js", "utf8");
const outbox = readFileSync("server/sheetSyncOutbox.js", "utf8");
const context = {
  Utilities: { formatDate(date) {
    return [String(date.getDate()).padStart(2, "0"), String(date.getMonth() + 1).padStart(2, "0"), date.getFullYear()].join("/");
  } },
};
vm.createContext(context);
vm.runInContext(extraction, context, { filename: "batchDataExtractionService.js" });
const parse = context.extractReportedTankPressure_;
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
]) assert.equal(parse(note), expected, note);

const header = ["תאריך", "שעה", "סוכר", "טמפרטורה", "לחץ", "pH", "גיזוז", "הערות"];
const row = (date, time, pressure, notes) => [date, time, "", "", pressure, "", "", notes];
const latest = (rows) => context.findLatestAvailableMeasurements([header, ...rows]);
const morning = row("29/10/2026", "07:00", "1.40Bar",
  "הורדת 2 דליי שמרים, לחץ אחרי 1.1 bar (דווח בשעה 10:30)");
const current = latest([morning]);
assert.equal(current.pressure, 1.1);
assert.equal(current.pressureSource, "action");
assert.ok(current.pressureUpdatedAt.includes("T"));
assert.equal(morning[4], "1.40Bar", "daily measurement must not be rewritten");
assert.equal(latest([row("29/10/2026", "07:00", "1.40Bar",
  "הורדת 2 דליי שמרים, לחץ אחרי 1.1 bar (דווח בשעה 10:30) | הורדת לחץ ל: 0 bar (דווח בשעה 13:00)")]).pressure, 0);
const laterReading = latest([
  row("29/10/2026", "07:00", "1.40Bar", "הורדת לחץ ל: 1.1 bar (דווח בשעה 10:30)"),
  row("29/10/2026", "12:00", "1.5Bar", ""),
]);
assert.equal(laterReading.pressure, 1.5);
assert.equal(laterReading.pressureSource, "measurement");
assert.equal(latest([
  row("28/10/2026", "07:00", "1.4Bar", "הורדת לחץ ל: 1.1 bar (דווח בשעה 15:00)"),
  row("29/10/2026", "07:00", "1.3Bar", ""),
]).pressure, 1.3);
// Legacy journals were appended after the row's original morning reading;
// the last pressure-changing action is the current pressure, not column E.
const legacyAction = row("29/10/2026", "07:00", "1.50Bar",
  "כיוון פורק ל: 1.6 bar | הורדת 6 דליי שמרים, לחץ אחרי 1.3 bar | העלאת לחץ ל: 1.6 bar");
const legacyRecovered = latest([legacyAction]);
assert.equal(legacyRecovered.pressure, 1.6);
assert.equal(legacyRecovered.pressureSource, "action");
assert.equal(legacyAction[4], "1.50Bar", "morning pressure is immutable");
assert.equal(latest([
  row("29/10/2026", "07:00", "1.4Bar", "הורדת לחץ ל: 0.7 bar"),
]).pressure, 0.7);
// A later independent pressure measurement still overrides those actions.
assert.equal(latest([
  legacyAction,
  row("29/10/2026", "14:00", "1.8Bar", ""),
]).pressure, 1.8);
// The reported PRV setpoint alone must not be used as measured pressure.
assert.equal(latest([
  row("29/10/2026", "07:00", "1.5Bar", "כיוון פורק ל: 1.6 bar"),
]).pressure, 1.5);
assert.equal(latest([
  row("28/10/2026", "07:00", "1.3Bar", ""),
  row("29/10/2026", "07:00", "", "הורדת 3 דליי שמרים, לחץ אחרי 0.8 bar"),
]).pressure, 0.8);

assert.match(quick, /reading\.pressureAfterAction = reportedPressure/);
assert.match(quick, /reading\.pressureRecordedAt = actionDate\.toISOString/);
assert.doesNotMatch(quick, /reading\.pressure = reportedPressure/);
assert.match(quick, /pressureAfterAction: !isEmpty && hasValidPressure/);
assert.doesNotMatch(quick, /pressure: !isEmpty && hasValidPressure/);
assert.match(writer, /field !== "pressure" && reading\[field\]/);
assert.match(writer, /key !== "pressure"/);
assert.match(writer, /reportedPressureUpdate\(row\.reading\)/);
assert.match(writer, /isNewerPressureUpdate\(live\?\.currentData\?\.pressureUpdatedAt/);
assert.match(writer, /transaction\.set\(refs\[index\]/);
assert.match(extraction, /pressure: extractNumber\(values\[r\]\[4\]\)/);
assert.equal((sync.match(/pressure: extractNumber\(values\[r\]\[4\]\)/g) || []).length, 2);
assert.match(sync, /storedAt > incomingAt/);
assert.match(outbox, /pressure: numberValue\(result\.pressure\)/);

console.log("Pressure timeline, morning-history preservation and sync guards passed.");
