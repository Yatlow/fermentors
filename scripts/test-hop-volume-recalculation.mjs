import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../src/SERVICES/brewing/hopVolumeRecalculation.ts");
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { shouldRecalculateHopAmount } = await import(
    "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

test("initial kettle volume calculates all hop doses, even with stale Master amounts", () => {
    for (const existing of [null, 0, 5, 600, 1800]) {
        assert.equal(shouldRecalculateHopAmount(null, existing, false), true);
    }
});
test("a later volume change does not silently replace manually adjusted hop amounts", () => {
    assert.equal(shouldRecalculateHopAmount(1200, 500, false), false);
    assert.equal(shouldRecalculateHopAmount(1200, 0, false), true);
    assert.equal(shouldRecalculateHopAmount(1200, null, false), true);
});
test("confirmation updates every recipe hop dose", () => {
    for (const existing of [null, 0, 300, 700]) {
        assert.equal(shouldRecalculateHopAmount(1200, existing, true), true);
    }
});
test("both typed kettle volume and calculator feed same commit path", () => {
    const form = read("../src/components/brewing/BrewFormStepper.tsx");
    assert.match(form, /onBlur=\{\(e\) =>\s*void commitSugar\("kettleVolume", e\.target\.value, 38, "C"\)/);
    assert.match(form, /await commitSugar\("kettleVolume", value, 38, "C", \{/);
    assert.match(form, /shouldRecalculateHopAmount\(/);
    assert.match(form, /onFocus=\{\(\) => \{[\s\S]*?committedKettleVolumeRef\.current\[currentBlock\]/);
    assert.match(form, /setExecution\(\(previous\) => \{/);
});
