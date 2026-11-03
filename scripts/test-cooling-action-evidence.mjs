import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
async function loadPureModule(relative) {
  const compiled = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
}
const { hasActualCooling } = await loadPureModule("../src/SERVICES/cellering/neglectAfterCooling.ts");
const { isCompletedYeastDrop } = await loadPureModule("../src/SERVICES/cellering/coolingYeastTiming.ts");

const tank19Note =
  "הורדת 3.2 דלי שמרים, לחץ אחרי 0.78 bar | העלאת לחץ ל: 1.1 bar | בעקבות הקירור הפלאטו גבוה מבדיקת תסיסה חמה - גיזוז רצוי 2.45 | הורדת לחץ ל0.9";
assert.equal(hasActualCooling(tank19Note), false,
  "Tank 19: 'בעקבות הקירור' in a yeast report is NOT an additional cooling event");
assert.equal(isCompletedYeastDrop(tank19Note), true,
  "Tank 19: the 3.2-bucket yeast drop IS an explicitly completed action");

for (const explanatory of [
  "בעקבות הקירור הפלאטו גבוה",
  "הורדת שמרים בעקבות הקירור",
  "הורדת לחץ בגלל קירור קודם",
  "המיכל לא הועבר לקירור",
  "מומלץ לבצע קירור",
  "נא לבצע קירור היום",
  "אחרי הקירור היה גיזוז 2.45",
]) {
  assert.equal(hasActualCooling(explanatory), false,
    `An explanation cannot count as physical cooling: ${explanatory}`);
}
for (const completed of [
  "קירור",
  "קירור מיכל ל0.3°",
  "התחלת קירור",
  "הועבר לקירור",
  "חזרה לקירור",
  "החזרה לקירור",
  "הורדת שמרים 3 דליים | קירור מיכל ל0.3°",
]) {
  assert.equal(hasActualCooling(completed), true,
    `Genuine cooling report must still be recognized: ${completed}`);
}
for (const action of [
  "הורדת שמרים",
  "הורדת 3.2 דלי שמרים",
  "הורדת 5 דליי שמרים",
  "הוצאת שמרים",
]) {
  assert.equal(isCompletedYeastDrop(action), true, `Completed yeast report: ${action}`);
}
for (const nonAction of [
  "מומלץ להוריד שמרים",
  "בדיקת שמרים",
  "בדיקת גיזוז אחרי הורדת שמרים",
  "הורדת לחץ אחרי טיפול בשמרים",
]) {
  assert.equal(isCompletedYeastDrop(nonAction), false, `Not evidence of yeast drop: ${nonAction}`);
}

const timeline = [
  { id: "2026-10-21_0810", notes: "קירור מיכל ל0.3°" },
  { id: "2026-10-23_0910", notes: "בדיקת גיזוז" },
  { id: "2026-11-03_1430", notes: tank19Note },
];
const coolingIndex = timeline.findLastIndex(m => hasActualCooling(m.notes));
assert.equal(coolingIndex, 0, "the real cooling date must remain anchored to Oct 21");
assert.deepEqual(timeline.slice(coolingIndex + 1).filter(m => isCompletedYeastDrop(m.notes))
  .map(m => m.id), ["2026-11-03_1430"],
  "Tank 19 has already completed the first post-cooling yeast drop");
assert.equal(timeline.filter(m => m.id.startsWith("2026-11-03") && hasActualCooling(m.notes)).length, 0,
  "Tank 19 must not earn new cooling points for an explanation");

const calculator = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
assert.match(calculator, /const CooledHopMeasurement = sortedMeasurements\.findLast\(\s*measurement => hasActualCooling/);
assert.match(calculator, /const coolingIndex = sortedMeasurements\.findLastIndex\(\s*measurement => hasActualCooling/);
assert.match(calculator, /const yeastMeasurementsAfterCooling = measurementsAfterCooling\.filter\(\s*\(measurement\) => isCompletedYeastDrop/);
assert.match(calculator, /const yeastDroppedOnce = measurements\.some\(\s*measurement => isCompletedYeastDrop/);
const dashboard = read("../src/components/dashboard/HealthDashboard.tsx");
assert.match(dashboard, /const hasTodayCooling = todayRows\.some\(\(measurement\) =>\s*hasActualCooling/);
assert.match(dashboard, /const hasTodayYeast = todayRows\.some\(\(measurement\) =>\s*isCompletedYeastDrop/);
assert.match(dashboard, /if \(hasTodayCooling && !completedScheduledCooling\) addCompleted/);
assert.doesNotMatch(dashboard, /if \(todayNotes\.includes\("קירור"\)/);
const forecast = read("../src/SERVICES/cellering/coldCellarForecast.ts");
const completions = read("../src/SERVICES/cellering/yeastCompletionForecast.ts");
assert.match(forecast, /hasActualCooling\(String\(item\.notes/);
assert.match(completions, /hasActualCooling\(String\(row\.notes/);

console.log("Tank 19: false cooling reset and cooling KPI prevented; completed yeast remains recognized");
