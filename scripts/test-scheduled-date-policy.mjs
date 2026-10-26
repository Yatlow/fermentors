import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const src = read("../src/SERVICES/cellering/scheduledDatePolicy.ts");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { scheduledDateValidationError: validate } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("past dates are always rejected even if native mobile picker accepted them", () => {
  assert.match(validate("2026-10-18", "2026-10-26"), /רק מהיום והלאה/);
  assert.match(validate("2026-10-25", "2026-10-26"), /רק מהיום והלאה/);
});

test("today and future dates are valid for every type of scheduled instruction", () => {
  assert.equal(validate("2026-10-26", "2026-10-26"), null);
  assert.equal(validate("2026-10-27", "2026-10-26"), null);
  assert.equal(validate("2027-04-01", "2026-10-26"), null);
});

test("cross-year scheduling uses calendar comparison, not an assumed day number", () => {
  assert.equal(validate("2027-01-01", "2026-12-31"), null);
  assert.match(validate("2026-12-31", "2027-01-01"), /רק מהיום והלאה/);
});

test("midnight rollover invalidates a date previously valid as today", () => {
  assert.equal(validate("2026-10-26", "2026-10-26"), null);
  assert.match(validate("2026-10-26", "2026-10-27"), /רק מהיום והלאה/);
});

test("malformed and nonexistent dates cannot be scheduled", () => {
  for (const value of ["", "18/10/2026", "2026-10-1", "2026-02-30", "2026-02-29", "2026-13-01", "2026-00-05", "2026-10-32", "not-a-date"]) {
    assert.match(validate(value, "2026-10-26"), /תאריך תקין/, value);
  }
  assert.equal(validate("2028-02-29", "2026-10-26"), null);
});

test("invalid today date is handled conservatively", () => {
  assert.match(validate("2027-01-01", "2026-99-99"), /תאריך תקין/);
});

test("write path validates before authentication, Firestore or preview writes", () => {
  const service = read("../src/SERVICES/cellering/scheduledCellarRecommendations.ts");
  const start = service.indexOf("export async function createScheduledCellarRecommendation(");
  const dateGuard = service.indexOf("scheduledDateValidationError(input.dueDate, todayDateKey())", start);
  const authRead = service.indexOf("const user = auth.currentUser;", start);
  const write = service.indexOf("await setDoc(ref,", start);
  assert.ok(start >= 0 && dateGuard > start && authRead > dateGuard && write > authRead);
  assert.match(service.slice(dateGuard, authRead), /if \(dateError\) throw new Error\(dateError\)/);
  assert.match(service, /if \(isPullRequestPreview\(\)\)/);
});

test("UI rejects old dates, prevents save, and shows a clear validation message", () => {
  const panel = read("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx");
  assert.match(panel, /min=\{today\}/);
  assert.match(panel, /scheduledDateValidationError\(dueDate, today\)/);
  assert.match(panel, /scheduledDateValidationError\(dueDate, todayDateKey\(\)\)/);
  assert.match(panel, /aria-invalid=\{Boolean\(selectedDateError\)\}/);
  assert.match(panel, /disabled=\{saving \|\| Boolean\(selectedDateError\)/);
  assert.match(panel, /className="scheduled-cellar-date-error"/);
  assert.match(panel, /setDueDate\(todayDateKey\(\)\)/);
});

test("legacy historical recommendations remain stored and today's due logic unchanged", () => {
  const service = read("../src/SERVICES/cellering/scheduledCellarRecommendations.ts");
  assert.match(service, /\.filter\(\(row\) => row\.dueDate === today\)/);
  assert.match(service, /row\.status === "active"/);
  assert.doesNotMatch(service, /deleteDoc\(/);
  const panel = read("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx");
  assert.match(panel, /const existing = useMemo\(/);
  assert.match(panel, /scheduledForTank\(rows, tankNumber, batchNumber\)/);
});
