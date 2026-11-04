import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const text = readFileSync(new URL("../src/SERVICES/brewing/brewSheet.ts", import.meta.url), "utf8");
const first = text.indexOf("function normalizedBrewSheetTime(");
const last = text.indexOf("type SheetOutbox", first);
assert.ok(first >= 0 && last > first, "Sheet clock normalizer must exist");
const source = text.slice(first, last);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const normalize = new Function("exports", js + "; return normalizeSheetValue;")({});

test("Time verification distinguishes 10:21 from 10:28", () => {
  assert.equal(normalize("9:54"), normalize("09:54"));
  assert.notEqual(normalize("10:21"), normalize("10:28"));
  assert.equal(normalize("10:21"), "#time:10:21");
  assert.equal(normalize("10:28"), "#time:10:28");
});

test("Numeric sheet values keep existing unit normalization", () => {
  // Water temperatures use their dedicated semantic comparison helper.
  // The general normalization intentionally does not treat arbitrary "°C" text as a number.
  assert.notEqual(normalize("62 °C"), normalize("62"));
  assert.equal(normalize("1335 ליטר"), normalize("1335"));
  assert.notEqual(normalize("10:21"), normalize("10"));
});

test("Never auto-resurrect user-deleted mash hours during form startup", () => {
  const form = readFileSync(new URL("../src/components/brewing/BrewFormStepper.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(form, /planMissingMashTimeSheetWrites|missingMashWrites/);
});


test("missing mash-rest duration is restored only from the matching configured recipe", async () => {
  const file = readFileSync(new URL("../src/SERVICES/brewing/mashRestDurationFallback.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(file, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { restoreMissingMashRestDurations: restore } = await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  );
  const snapshot = {
    style: "IPA",
    mash: { steps: [
      { id: "rest1", minutes: undefined }, { id: "rest2", minutes: 15 },
      { id: "rest3", minutes: 0 }, { id: "heat1", minutes: undefined },
    ] },
  };
  const current = { style: "IPA", mash: { steps: [
    { id: "rest1", minutes: 30 }, { id: "rest2", minutes: 25 },
    { id: "rest3", minutes: 10 }, { id: "heat1", minutes: 10 },
  ] } };
  const result = restore(snapshot, current);
  assert.deepEqual(result.mash.steps.map(s => s.minutes), [30, 15, 0, undefined]);
  assert.equal(snapshot.mash.steps[0].minutes, undefined, "never mutate source recipe");
  assert.equal(restore(snapshot, { ...current, style: "Stout" }), snapshot);
  assert.equal(restore(snapshot, null), snapshot);
});

test("mash time cascade saves app state before checking mapping and warns on missing rest duration", () => {
  const form = readFileSync(new URL("../src/components/brewing/BrewFormStepper.tsx", import.meta.url), "utf8");
  const routine = form.slice(form.indexOf("async function commitStageStart("), form.indexOf("async function commitStage(", form.indexOf("async function commitStageStart(")));
  assert.match(routine, /const calculatedEnd = addMinutesToTime\(value, duration\)/);
  assert.ok(routine.indexOf("setExecution(nextExecution)") < routine.indexOf("writePlannedStageSheetCells("));
  assert.match(routine, /duration === null/);
  assert.match(form, /הזמנים נשמרו בטופס, אך לא נכתבו ל-Sheet/);
  assert.match(form, /clearCalculatedSuccessors/);
});
