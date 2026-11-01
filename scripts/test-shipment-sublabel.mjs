import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/planning/shipmentSubLabelPolicy.ts", import.meta.url), "utf8");
const moduleText = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const url = "data:text/javascript;base64," + Buffer.from(moduleText).toString("base64");
const { hasPalletSubLabel, splitShipmentAutoPicks } = await import(url);

assert.equal(hasPalletSubLabel({ subLabel: "מבצע" }), true);
assert.equal(hasPalletSubLabel({ subLabel: "  " }), false);
assert.equal(hasPalletSubLabel({ subLabel: null }), false);
assert.equal(hasPalletSubLabel({}), false);

const [special, ordinary, secondSpecial] = [
  { id: "special", subLabel: "ללקוח", quantity: 84 },
  { id: "ordinary", quantity: 84 },
  { id: "second", subLabel: "מהדורה מיוחדת", quantity: 42 },
];
const picked = splitShipmentAutoPicks([special, ordinary, secondSpecial]);
assert.deepEqual(picked.ordinary, [ordinary], "Only unlabelled pallets may be auto-marked");
assert.deepEqual(picked.awaitingPlanner, [special, secondSpecial], "Labeled pallets remain for explicit review");
assert.deepEqual(splitShipmentAutoPicks([]), { ordinary: [], awaitingPlanner: [] });
console.log("Shipment sub-label policy regression checks passed");
