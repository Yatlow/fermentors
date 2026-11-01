import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const source = read("../src/SERVICES/dashboard/fermentorSnapshotIdentity.ts");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { tankStageInputsEqual, sameTankReferences } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
const previous = {
  action: 1,
  batchNumber: "#1610",
  tankStatus: false,
  currentData: { temp: 1.2, pressure: 1.4, notes: "" },
  cellarState: { batchNumber: "1610", cooled: true },
};
assert.equal(tankStageInputsEqual(previous, {
  ...previous, currentData: { ...previous.currentData, pressure: 1.6, pH: 4.3 },
}), true, "pressure/pH reports cannot temporarily reset stage");
assert.equal(tankStageInputsEqual(previous, { ...previous, batchNumber: "#1611" }), false);
assert.equal(tankStageInputsEqual(previous, { ...previous, action: 3 }), false);
assert.equal(tankStageInputsEqual(previous, { ...previous, tankStatus: true }), false);
assert.equal(tankStageInputsEqual(previous, { ...previous, currentData: { ...previous.currentData, temp: 15 } }), false);
assert.equal(tankStageInputsEqual(previous, {
  ...previous, cellarState: { ...previous.cellarState, cooled: false },
}), false);
assert.equal(tankStageInputsEqual(previous, {
  ...previous, currentData: { ...previous.currentData, notes: "התחלת קירור" },
}), false);
const arr = [previous, { ...previous, batchNumber: "1613" }];
assert.equal(sameTankReferences(arr, [...arr]), true);
assert.equal(sameTankReferences(arr, [arr[0], { ...arr[1] }]), false);
assert.equal(sameTankReferences(arr, [arr[0]]), false);

const app = read("../src/App.tsx");
assert.ok(app.indexOf("const nextTank = { ...firestoreData") < app.indexOf("JSON.stringify(prevRest)"),
  "normalize Firestore brewProgress before comparing with displayed value");
assert.match(app, /tankStageInputsEqual\(prevTank, nextTank\)/);
assert.match(app, /return sameTankReferences\(prevBrews, data\) \? prevBrews : data/);
assert.match(app, /return sameTankReferences\(prev, next\) \? prev : next/);
console.log("Unchanged Firestore snapshots reuse React references and preserve tank stages");
