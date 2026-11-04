import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const engine = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
const dashboard = read("../src/components/dashboard/HealthDashboard.tsx");
const styles = read("../src/components/dashboard/HealthDashboard.css");

test("pressure advice identifies the CURRENT bad carbonation test, not a historical milestone", () => {
  assert.match(engine, /carbonationTestOutOfSpec: coldCarbNeedsPressureAdjustment/);
  assert.match(engine, /בדיקת הגיזוז האחרונה לא תקינה/);
  assert.match(engine, /בדיקת הגיזוז היום לא תקינה/);
  assert.match(engine, /בדיקת הגיזוז האחרונה תקינה/);
  assert.doesNotMatch(engine, /לאחר שכבר הושג גיזוז תקין|טרם הושג גיזוז תקין באצווה|הגיזוז הגיע לראשונה לטווח התקין/);
  // Internal historical milestone still chooses direction and availability of hold.
  assert.match(engine, /subsequentCarbonationPressureAdvice\(/);
  assert.match(engine, /hasReachedCarbonationRange\(/);
  assert.match(engine, /pressureChoice: beforeFirstInRangeCarbonation \|\| firstInRangeAdvice !== null/);
});

test("out-of-spec pressure recommendation shows explicit bad-test title", () => {
  assert.match(dashboard, /recommendation\.recommendationKey === "pressureAdjustment" &&\s*recommendation\.carbonationTestOutOfSpec/);
  assert.match(dashboard, /מיכל \$\{number\}: בדיקת גיזוז לא תקינה/);
  assert.match(dashboard, /carbonationTestOutOfSpec: recommendation\.carbonationTestOutOfSpec/);
});

test("hold action stays usable with concise neutral mobile-safe presentation", () => {
  assert.match(dashboard, /className="health-quick-report-button health-pressure-hold-button"/);
  assert.match(dashboard, /aria-label="דווח השארת לחץ ללא שינוי"/);
  assert.match(dashboard, /<Equal size=\{17\} aria-hidden="true" \/>ללא שינוי/);
  assert.match(dashboard, /noteType: "השארת לחץ"/);
  assert.match(styles, /health-pressure-hold-button/);
  assert.match(styles, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.health-alert:has\(\.health-pressure-choices\)/);
  assert.match(styles, /grid-template-areas:/);
});
