import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("packaging print text is editable via local overrides and rendered in the print preview", () => {
  const s = source("../src/COMPONENTS/PackagingSheetGenerator.tsx");
  for (const key of ["style", "batch", "skuLabel", "sku", "expiry"]) {
    assert.match(s, new RegExp("printOverrides\\." + key));
  }
  assert.match(s, /ערוך טקסט/);
  assert.match(s, /resetPrintText/);
  assert.match(s, /source\.outerHTML/);
  assert.doesNotMatch(s, /setDoc|updateDoc|writeBrewSheetCells/);
});
test("brew form has no print text editor or print-replacement API", () => {
  const view = source("../src/components/brewing/BrewingView.tsx");
  const api = source("../src/SERVICES/brewing/brewingSheetServer.ts");
  const gas = source("../server/BREWING_SHEET_SERVICE.js");
  for (const s of [view, api, gas]) {
    assert.doesNotMatch(s, /BrewPrintTextEditor|textReplacements|printEditRun/);
  }
});
test("salinity formula caption removed but calculator remains", () => {
  const s = source("../src/components/tools/BrewerCalc.tsx");
  assert.match(s, /calculateSalinityCorrection/);
  assert.doesNotMatch(s, /לפי נוסחת העבודה/);
});
