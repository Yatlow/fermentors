import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const toJs = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataUri = (source) => "data:text/javascript;base64," + Buffer.from(toJs(source)).toString("base64");
const startingPlato = dataUri(read("../src/SERVICES/brewing/startingPlato.ts"));
const source = read("../src/SERVICES/brewing/hydrometerResultTarget.ts")
  .replace('from "./startingPlato"', `from "${startingPlato}"`);
const { applyHydrometerResult, HYDROMETER_SHEET_FIELDS } = await import(dataUri(source));

const batch = "1607";
const makeExecution = (activeBlockIndex = 3) => ({
  batchNumber: batch, activeBlockIndex, activeStepIndex: 4, reviewedSteps: { "1:lautering": true },
  updatedAt: new Date("2026-10-19").toISOString(),
  blocks: Object.fromEntries([1, 2, 3].map((block) => [
    String(block),
    { fields: {
      extra: `untouched ${block}`,
      frPlato: String(block * 10 + 1),
      lrPlato: String(block * 10 + 2),
      kettlePlato: String(block * 10 + 3),
      endBoilPlato: String(block * 10 + 4),
      endBoilVolume: "1200",
      fermentorSamplePlato: String(block * 10 + 5),
      boilSamplePlato: String(block * 10 + 6),
      ...Object.fromEntries(HYDROMETER_SHEET_FIELDS.map((field, i) =>
        [`__sheetRow.sugar.${field}`, String(5 + (block - 1) * 50 + i * 3)])),
      "__sheetRow.fermentation": "156",
    } },
  ])),
});

test("all five sheet-backed hydrometer fields preserve origin across A/B/C", () => {
  for (const field of HYDROMETER_SHEET_FIELDS) {
    for (const blockIndex of [1, 2, 3]) {
      // Active block is intentionally different from the modal's source.
      const current = makeExecution(blockIndex === 3 ? 1 : 3);
      const original = structuredClone(current);
      const target = { batchNumber: batch, blockIndex, field };
      const { nextExecution, writes, value } = applyHydrometerResult(current, target, 13.267, {
        sheetBacked: true, totalBlocks: 3,
      });
      assert.equal(value, "13.27");
      const row = original.blocks[String(blockIndex)].fields[`__sheetRow.sugar.${field}`];
      assert.deepEqual(writes[0], { range: `'גיליון1'!B${row}`, value: 13.27 });
      assert.equal(nextExecution.blocks[String(blockIndex)].fields[field], "13.27");
      assert.equal(nextExecution.activeBlockIndex, original.activeBlockIndex);
      assert.equal(nextExecution.activeStepIndex, original.activeStepIndex);
      assert.deepEqual(nextExecution.reviewedSteps, original.reviewedSteps);
      for (const block of [1, 2, 3]) {
        for (const [key, previousValue] of Object.entries(original.blocks[String(block)].fields)) {
          if (block === blockIndex && key === field) continue;
          assert.equal(nextExecution.blocks[String(block)].fields[key], previousValue,
            `unrelated ${block}.${key} must not change`);
        }
      }
      assert.deepEqual(current, original, "source execution is immutable");
    }
  }
});

test("boil-volume calculator Plato is local-only and still targets the original block", () => {
  const current = makeExecution(3);
  const target = { batchNumber: batch, blockIndex: 1, field: "boilSamplePlato" };
  const { writes, nextExecution } = applyHydrometerResult(current, target, 15.999, {
    sheetBacked: true, totalBlocks: 3,
  });
  assert.deepEqual(writes, []);
  assert.equal(nextExecution.blocks["1"].fields.boilSamplePlato, "16.00");
  assert.equal(nextExecution.blocks["3"].fields.boilSamplePlato, current.blocks["3"].fields.boilSamplePlato);
});

test("end-of-boil hydrometer result updates the correct weighted starting Plato row", () => {
  const current = makeExecution();
  for (const block of ["1", "2", "3"]) current.blocks[block].fields.endBoilPlato = "15.00";
  const { writes } = applyHydrometerResult(current, {
    batchNumber: batch, blockIndex: 2, field: "endBoilPlato",
  }, 16.00, { sheetBacked: true, totalBlocks: 3 });
  assert.deepEqual(writes, [
    { range: "'גיליון1'!B64", value: 16 },
    { range: "'גיליון1'!D156", value: 15.38 },
  ]);
});

test("missing semantic maps and mismatched batches are rejected before any update", () => {
  const current = makeExecution();
  delete current.blocks["2"].fields["__sheetRow.sugar.frPlato"];
  assert.throws(() => applyHydrometerResult(current,
    { batchNumber: batch, blockIndex: 2, field: "frPlato" }, 11.5,
    { sheetBacked: true, totalBlocks: 3 },
  ), /מיפוי סמנטי/);
  assert.throws(() => applyHydrometerResult(current,
    { batchNumber: "DIFFERENT", blockIndex: 2, field: "kettlePlato" }, 11.5,
    { sheetBacked: true, totalBlocks: 3 },
  ), /לא תואמים/);
  assert.throws(() => applyHydrometerResult(current,
    { batchNumber: batch, blockIndex: 4, field: "kettlePlato" }, 11.5,
    { sheetBacked: true, totalBlocks: 3 },
  ), /לא תואמים/);
});

test("six UI entry points all use the same pinned destination mechanism", () => {
  const form = read("../src/components/brewing/BrewFormStepper.tsx");
  for (const field of [...HYDROMETER_SHEET_FIELDS, "boilSamplePlato"]) {
    assert.match(form, new RegExp(`openHydrometer\\("${field}"\\)`));
  }
  assert.match(form, /applyHydrometerResult\(execution, target, result/);
  assert.doesNotMatch(form, /setHydrometerTarget\("(?:frPlato|lrPlato|kettlePlato|endBoilPlato|fermentorSamplePlato|boilSamplePlato)"\)/);
});
