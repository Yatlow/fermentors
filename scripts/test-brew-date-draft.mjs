import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const form = readFileSync(new URL("../src/components/brewing/BrewFormStepper.tsx", import.meta.url), "utf8");

// Exercise the date formatter/parser used by the actual form, without
// mounting the production Firebase client or mutating real brew data.
const start = form.indexOf("function formatIsraeliDateTyping(");
const end = form.indexOf("function minutesFromMidnight(", start);
assert.ok(start !== -1 && end > start, "brew date helpers must be discoverable");
const helperSource = form.slice(start, end) +
  "\nexport { formatIsraeliDateTyping, isoDateFromUserInput };\n";
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { formatIsraeliDateTyping, isoDateFromUserInput } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

assert.equal(formatIsraeliDateTyping("0"), "0");
assert.equal(formatIsraeliDateTyping("03"), "03/");
assert.equal(formatIsraeliDateTyping("0311"), "03/11/");
assert.equal(formatIsraeliDateTyping("031126"), "03/11/26");
assert.equal(formatIsraeliDateTyping("03112026"), "03/11/2026");
assert.equal(formatIsraeliDateTyping("03/11/26"), "03/11/26");
assert.equal(isoDateFromUserInput("03/11/26"), "2026-11-03");
assert.equal(isoDateFromUserInput("03/11/2026"), "2026-11-03");
assert.equal(isoDateFromUserInput("31/02/26"), null, "invalid calendar date cannot be saved");
assert.equal(isoDateFromUserInput("03/11/2"), null, "incomplete typing is not a committed date");

// Guard the interaction: onChange stores a per-block draft; no re-mounting
// key or uncontrolled defaultValue can erase it after an unrelated rerender.
const dateCard = form.match(/<article className="brew-prep-date-card">[\s\S]*?<\/article>/)?.[0];
assert.ok(dateCard, "brew date input must exist");
assert.match(dateCard, /value=\{brewDateDrafts\[currentBlock\] \?\? shortIsraeliDate\(localValue\("brewDate"\)\)\}/);
assert.match(dateCard, /onChange=\{\(e\) => editBrewDate\(e\.target\.value, currentBlock\)\}/);
assert.match(dateCard, /onBlur=\{\(e\) => void commitBrewDate\(e\.currentTarget\.value\)\}/);
assert.doesNotMatch(dateCard, /defaultValue=|key=\{|onInput=/, "do not reset/mutate uncontrolled date input");

const edit = form.slice(form.indexOf("function editBrewDate("), form.indexOf("function selectedMaterialLot("));
assert.match(edit, /latestLocalEditAt\.current = Date\.now\(\)/, "protect draft from an in-flight Sheet hydration");
assert.match(edit, /setBrewDateDrafts\(\(previous\) => \(\{ \.\.\.previous, \[blockIndex\]: formatted \}\)\)/);
const commit = form.slice(form.indexOf("async function commitBrewDate("), form.indexOf("async function confirmMaterials("));
assert.match(commit, /if \(value === null\)/);
assert.match(commit, /if \(minimumDate && value < minimumDate\.date\)/);
assert.match(commit, /setExecution\(\(previous\) => \{/);
assert.match(commit, /setBrewingExecutionField\(previous, currentBlock, "brewDate", value\)/);
assert.doesNotMatch(commit, /setBrewingExecutionField\(execution, currentBlock, "brewDate"/);
assert.match(commit, /setBrewDateDrafts\(\(previous\) => \{/, "clear draft only after a valid commit");
const select = form.slice(form.indexOf("async function selectBlock("), form.indexOf("function openHydrometer("));
assert.match(select, /setExecution\(\(previous\) =>/);
assert.doesNotMatch(select, /setBrewingExecutionActiveBlock\(execution, index\)/,
  "A/B/C navigation must never revert the date using a stale render snapshot");

console.log("Brew date parsing, controlled draft, blur commit and A/B/C navigation safeguards passed");
