import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/tools/salinityCorrection.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { calculateSalinityCorrection } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("worksheet example 220 liters at 4.65 returns 1.27", () => {
    assert.equal(calculateSalinityCorrection(220, 4.65)?.toFixed(2), "1.27");
});
test("correction declines to zero at a salinity of 11", () => {
    assert.equal(calculateSalinityCorrection(220, 11), 0);
    assert.equal(calculateSalinityCorrection(220, 0), 2.2);
});
test("negative, impossible or nonfinite measurements are rejected", () => {
    assert.equal(calculateSalinityCorrection(-1, 4), null);
    assert.equal(calculateSalinityCorrection(220, 12), null);
    assert.equal(calculateSalinityCorrection(220, NaN), null);
});
