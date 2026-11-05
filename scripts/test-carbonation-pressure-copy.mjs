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

test("pressure hold retains its exact original appearance, label and action", () => {
  assert.match(dashboard, /<Gauge size=\{16\} aria-hidden="true" \/>השארת לחץ ללא שינוי/);
  assert.match(dashboard, /noteType: "השארת לחץ"/);
  assert.match(dashboard, /className="health-quick-report-button"/);
  assert.doesNotMatch(dashboard, /health-pressure-hold-button|health-pressure-change-button|<Equal size=/);
  assert.doesNotMatch(styles, /health-pressure-hold-button|health-pressure-change-button/);
  // The ONLY adjustment is placement below text on phones and wrapping
  // within the existing card; do not alter the button's color/padding/shape.
  assert.match(styles, /\.health-alert:has\(\.health-pressure-choices\)/);
  assert.match(styles, /grid-template-areas:/);
  assert.match(styles, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /min-width: 0;/);
  assert.match(styles, /white-space: normal;/);
  assert.doesNotMatch(styles, /health-pressure-choices \.health-quick-report-button\s*\{[^}]*?(?:background|border-color|font-size|border-radius|padding):/s);
});


test("all mobile cellar recommendation explanations span the card, not the button column", () => {
  assert.match(styles, /\.health-dashboard \.health-alert > \.health-alert-copy\s*\{\s*display: contents;/);
  assert.match(styles, /\.health-dashboard \.health-alert > \.health-alert-copy > span\s*\{\s*grid-area: detail;/);
  assert.match(styles, /"detail detail detail"/);
  assert.match(styles, /\.health-dashboard \.health-alert > \.health-quick-report-button\s*\{\s*grid-area: actions;/);
  assert.match(styles, /\.health-dashboard \.health-alert > \.health-pressure-choices\s*\{\s*grid-area: actions;/);
  assert.match(styles, /\.health-dashboard \.health-alert > \.health-ignore-button\s*\{\s*grid-area: ignore;/);
});
