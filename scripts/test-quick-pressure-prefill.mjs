import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/cellering/quickReportPressureDecision.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { pressurePrefillFromScheduledDecision } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

const decision = {
  tankNumber: "4",
  batchNumber: "#1613",
  recommendationId: "scheduled-abc123",
  pressureDirection: "lower",
  targetPressure: 0.1,
};
assert.deepEqual(
  pressurePrefillFromScheduledDecision(decision, "4", "1613"),
  { direction: "הורדת", pressure: "0.1" },
  "scheduled lowering must preselect both direction and target"
);
assert.deepEqual(
  pressurePrefillFromScheduledDecision({ ...decision, pressureDirection: "raise", targetPressure: 1.6 }, 4, "#1613"),
  { direction: "העלאת", pressure: "1.6" },
  "scheduled raising must preselect both direction and target"
);
assert.deepEqual(
  pressurePrefillFromScheduledDecision({ ...decision, targetPressure: 0 }, 4, "#1613"),
  { direction: "הורדת", pressure: "0" },
  "zero target must not be rejected as falsy"
);
assert.equal(pressurePrefillFromScheduledDecision(null, "4", "#1613"), null, "ordinary manual reports stay empty");
assert.equal(pressurePrefillFromScheduledDecision(decision, "5", "1613"), null, "different tank");
assert.equal(pressurePrefillFromScheduledDecision(decision, "4", "#1614"), null, "previous batch");
assert.equal(pressurePrefillFromScheduledDecision({ ...decision, pressureDirection: undefined }, "4", "#1613"), null, "legacy missing direction");
assert.equal(pressurePrefillFromScheduledDecision({ ...decision, targetPressure: undefined }, "4", "#1613"), null, "missing target");
assert.equal(pressurePrefillFromScheduledDecision({ ...decision, targetPressure: Number.NaN }, "4", "#1613"), null, "not numeric");
assert.equal(pressurePrefillFromScheduledDecision({ ...decision, targetPressure: 6 }, "4", "#1613"), null, "outside pressure validation");
assert.equal(pressurePrefillFromScheduledDecision({ ...decision, recommendationId: "pressureAdjustment" }, "4", "#1613"), null, "automatic advice is not a decision");

const health = readFileSync(new URL("../src/components/dashboard/HealthDashboard.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../src/components/dashboard/TankCard.tsx", import.meta.url), "utf8");
const quick = readFileSync(new URL("../src/components/dashboard/QuickTankReportBox.tsx", import.meta.url), "utf8");
assert.match(health, /pressureDirection: row\.actionType === "pressureChange" \? row\.pressureDirection/);
assert.match(health, /targetPressure: row\.actionType === "pressureChange" \? row\.targetPressure/);
assert.match(health, /pressureDecision: noteType === "לחץ"/);
assert.match(card, /initialPressureDecision=\{quickReportPressureDecision\}/);
assert.match(card, /setQuickReportPressureDecision\(null\)/, "independent quick reports must clear defaults");
assert.match(quick, /setDirection\(prefill\.direction\)/);
assert.match(quick, /setValue\(prefill\.pressure\)/);
assert.match(quick, /initialSelectionAppliedRef/, "async history loads must not overwrite the operator's pressure edit");

assert.match(health, /noteType: "השארת לחץ"/);
assert.match(health, /initialPressureDirection: alert\.pressureSuggestion === "lower"/);
assert.match(health, /alert\.pressureSuggestion === "raise" \? "העלאת" : undefined/);
assert.match(card, /setQuickReportInitialPressureDirection\(/);
assert.match(quick, /initialPressureDirection === "העלאת"/);
assert.match(quick, /case "השארת לחץ": return holdPressureConfirmed/);
assert.match(quick, /"השארת לחץ ללא שינוי לאחר בדיקת גיזוז/);
assert.match(quick, /const isPressureAction = noteType === "לחץ"/);
assert.doesNotMatch(quick, /const isPressureAction = noteType === "השארת לחץ"/);

// Hold is only offered until AND INCLUDING the first in-range carbonation
// measurement. Later out-of-range readings always have one directional action.
const engine = readFileSync(new URL("../src/SERVICES/cellering/calculateCelleringRecomendations.ts", import.meta.url), "utf8");
const pressurePolicy = readFileSync(new URL("../src/SERVICES/cellering/carbonationPressureInsights.ts", import.meta.url), "utf8");
assert.match(engine, /const beforeFirstInRangeCarbonation = coldCarbNeedsPressureAdjustment/);
assert.match(engine, /!hasReachedCarbonationRange\(/);
assert.match(engine, /pressureChoice: beforeFirstInRangeCarbonation \|\| firstInRangeAdvice !== null/);
assert.match(engine, /\? "changeOrHold" as const : undefined/);
assert.match(engine, /actionType: coldCarbNeedsPressureAdjustment \|\| firstInRangeAdvice/);
assert.doesNotMatch(engine, /subsequentPressureAdvice\?\.kind === "lowerOrHold"/);
assert.doesNotMatch(pressurePolicy, /lowerOrHold/);
assert.match(health, /pressureChoice\?: "changeOrHold"/);
assert.match(health, /if \(alert\.pressureChoice && available\)/);
assert.match(health, /alert\.pressureSuggestion === "lower"[\s\S]*?\? "דווח הורדת לחץ"/);
assert.match(health, /alert\.pressureSuggestion === "raise" \? "דווח העלאת לחץ" : "דווח שינוי לחץ"/);
assert.match(health, /initialPressureDirection: alert\.pressureSuggestion === "lower"/);
assert.match(health, /noteType: "השארת לחץ"/);
assert.match(health, /noteType === "לחץ" && alert\.pressureSuggestion/);
assert.match(health, /alert\.pressureSuggestion === "lower" \? "דווח הורדת לחץ" : "דווח העלאת לחץ"/,
  "post-first deviation must expose only the specific recommended pressure direction");
assert.match(quick, /case "השארת לחץ": return holdPressureConfirmed/);
assert.match(quick, /const isPressureAction = noteType === "לחץ"/);
assert.doesNotMatch(quick, /const isPressureAction = noteType === "השארת לחץ"/);

console.log("Scheduled pressure quick-report prefill checks passed");
