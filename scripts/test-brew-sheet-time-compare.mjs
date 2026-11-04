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
