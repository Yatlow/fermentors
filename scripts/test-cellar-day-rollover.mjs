import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const dashboard = read("../src/components/dashboard/HealthDashboard.tsx");
const completed = read("../src/SERVICES/cellering/scheduledCellarRecommendations.ts");
const ignored = read("../src/SERVICES/cellering/ignoredCellarRecommendations.ts");
const grace = read("../src/SERVICES/dashboard/cellarGrace.ts");
const health = read("../src/SERVICES/dashboard/healthModel.ts");

function parseTypeScript(source, name, kind = ts.ScriptKind.TS) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
  assert.deepEqual(file.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), [], name);
}

test("daily rollover changes only the narrow date-scoped listeners", () => {
  assert.match(dashboard, /useEffect\(\(\) => subscribeScheduledCellarRecommendations\([\s\S]*?\), \[\]\);/,
    "active decision listener is mounted once and never restarted for day changes");
  assert.match(dashboard, /subscribeCompletedScheduledCellarRecommendationsToday\([\s\S]*?calendarDay\s*\)/);
  assert.match(dashboard, /subscribeIgnoredCellarRecommendationsToday\([\s\S]*?calendarDay\s*\)/);
  assert.match(dashboard, /unsubscribeCompleted\(\);\s*unsubscribeIgnored\(\);\s*\};\s*\}, \[calendarDay\]\);/,
    "previous day's listeners are cleaned up before replacing them");
  assert.match(completed, /subscribeCompletedScheduledCellarRecommendationsToday\([\s\S]*?today = todayDateKey\(\)/);
  assert.match(ignored, /subscribeIgnoredCellarRecommendationsToday\([\s\S]*?today = todayDateKey\(\)/);
  assert.match(completed, /where\("resolvedDate", "==", today\)/);
  assert.match(ignored, /where\("ignoredDate", "==", today\)/);
  assert.doesNotMatch(dashboard, /setInterval\(/, "no polling added");
});

test("stale yesterday completions and ignores cannot enter today's display or KPI", () => {
  assert.match(dashboard, /completedScheduledToday\.filter\(\(row\) => row\.status === "completed" && row\.resolvedDate === calendarDay\)/);
  assert.match(dashboard, /ignoredRecommendations\.filter\(\(row\) => row\.ignoredDate === calendarDay\)/);
  assert.match(dashboard, /completedScheduledForCalendarDay\.filter\(\(row\)/);
  assert.match(dashboard, /ignoredRecommendationsForCalendarDay,/);
  assert.match(dashboard, /analysis\.analyzedDay === calendarDay && analysis\.completedActions\.length > 0/);
  assert.match(dashboard, /analysis\.analyzedDay === calendarDay \? analysis\.completedActions : \[\]/);
  assert.match(dashboard, /const isCurrentDay = \(\) => !disposed && calendarDay === localDateKey\(new Date\(\)\)/);
});

test("midnight changes the local day, but 04:00 remains a grace-only boundary", async () => {
  const js = ts.transpileModule(health, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { localDateKey } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  assert.equal(localDateKey(new Date(2026, 10, 8, 23, 59)), "2026-11-08");
  assert.equal(localDateKey(new Date(2026, 10, 9, 0, 0)), "2026-11-09");
  assert.equal(localDateKey(new Date(2026, 10, 9, 3, 59)), "2026-11-09");
  assert.equal(localDateKey(new Date(2026, 10, 9, 4, 0)), "2026-11-09");
  assert.match(dashboard, /Math\.min\(midnight, nextGraceBoundary\.getTime\(\)/);
  assert.match(dashboard, /const today = localDateKey\(new Date\(\)\);\s*\/\/ A same-day focus or 04:00 grace reset must not restart listeners\.\s*setCalendarDay\(\(current\) => current === today \? current : today\);/);
  assert.match(dashboard, /refreshCalendarDay\(\);\s*setMeasurementRefresh/);
  assert.match(grace, /export const GRACE_RESET_HOUR = 4/);
  assert.match(grace, /export const FERMENTATION_GRACE_MS = 12 \* 60 \* 60 \* 1000/);
});

test("changed TS/TSX source remains syntactically valid", () => {
  parseTypeScript(dashboard, "HealthDashboard.tsx", ts.ScriptKind.TSX);
  parseTypeScript(completed, "scheduledCellarRecommendations.ts");
  parseTypeScript(ignored, "ignoredCellarRecommendations.ts");
});
