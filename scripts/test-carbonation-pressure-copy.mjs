import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const engine = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
const dashboard = read("../src/components/dashboard/HealthDashboard.tsx");
const titleFormatter = read("../src/SERVICES/dashboard/cellarRecommendationTitles.ts");
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

test("out-of-spec pressure recommendation preserves explicit bad-test context in title and detail", () => {
  assert.match(dashboard, /title: cellarRecommendationTitle\(/);
  assert.match(dashboard, /carbonationTestOutOfSpec: recommendation\.carbonationTestOutOfSpec/);
  assert.match(titleFormatter, /input\.carbonationTestOutOfSpec/);
  assert.match(titleFormatter, /המלצה לשינוי לחץ לאחר בדיקת גיזוז לא תקינה/);
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


const pressureDecisionSource = read("../src/SERVICES/cellering/pressureDecisionCopy.ts");
const pressureDecisionJavaScript = ts.transpileModule(pressureDecisionSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { stripPressureChoiceInstructions, pressureDecisionContext } = await import(
  "data:text/javascript;base64," + Buffer.from(pressureDecisionJavaScript).toString("base64")
);

test("a pressure decision records test context and target without alternative hold guidance", () => {
  const recommendation = "בדיקת הגיזוז היום לא תקינה (2.35, יעד 2.4). לחץ במיכל: 0.71 bar. ניתן לדווח על שינוי לחץ או לבחור להשאיר את הלחץ ללא שינוי, בהתאם לשיקול דעת המבשל.";
  const instruction = `${pressureDecisionContext(recommendation)}. יש לבצע העלאת לחץ ל-1 bar`;
  assert.equal(instruction, "בדיקת הגיזוז היום לא תקינה (2.35, יעד 2.4). לחץ במיכל: 0.71 bar. יש לבצע העלאת לחץ ל-1 bar");
  assert.match(engine, /ניתן לדווח על שינוי לחץ או לבחור להשאיר את הלחץ ללא שינוי/);
  assert.match(read("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx"), /pressureDecisionContext\(pressureDecisionCandidate\.reason\)/);
});

test("saved decisions lose obsolete choice instructions in the dashboard and future list", () => {
  const legacy = "בדיקת הגיזוז היום לא תקינה (2.35, יעד 2.4). לחץ במיכל: 0.71 bar. ניתן לדווח על שינוי לחץ או לבחור להשאיר את הלחץ ללא שינוי, בהתאם לשיקול דעת המבשל. יש לבצע העלאת לחץ ל-1 bar";
  const clean = stripPressureChoiceInstructions(legacy);
  assert.equal(clean, "בדיקת הגיזוז היום לא תקינה (2.35, יעד 2.4). לחץ במיכל: 0.71 bar. יש לבצע העלאת לחץ ל-1 bar");
  assert.match(dashboard, /stripPressureChoiceInstructions\(row\.note/);
  assert.match(read("../src/components/dashboard/ScheduledCellarRecommendationsPanel.tsx"), /stripPressureChoiceInstructions\(row\.note/);
});

test("first valid carbonation pressure decisions also exclude optional hold wording", () => {
  const recommendation = "בדיקת הגיזוז האחרונה תקינה (2.4, יעד 2.4). לחץ במיכל: 1 bar. ניתן לשקול הורדת לחץ או לבחור להשאיר את הלחץ ללא שינוי.";
  assert.equal(pressureDecisionContext(recommendation), "בדיקת הגיזוז האחרונה תקינה (2.4, יעד 2.4). לחץ במיכל: 1 bar");
});
