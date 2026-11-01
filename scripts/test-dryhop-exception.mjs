import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/cellering/dryHopHistory.ts", import.meta.url), "utf8");
const moduleText = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const path = "data:text/javascript;base64," + Buffer.from(moduleText).toString("base64");
const { dryHopActionCount, isAdditionalDryHopAllowed } = await import(path);
assert.equal(dryHopActionCount([]), 0);
assert.equal(dryHopActionCount([{ notes: "הכנסת כשות 4. דרייהופ. 3600 גרם" }]), 1);
assert.equal(dryHopActionCount([{ notes: "הכנסת כשות 4. דרייהופ. 3600 גרם | דרייהופ נוסף (חריג). 1200 גרם" }]), 2);
assert.equal(dryHopActionCount([{ notes: "הכנסת כשות 4. 2500 גרם" }]), 1);
assert.equal(dryHopActionCount([{ notes: "מנוחת דיאציטיל" }]), 0);
assert.equal(isAdditionalDryHopAllowed(null), false);
assert.equal(isAdditionalDryHopAllowed(0), false);
assert.equal(isAdditionalDryHopAllowed(1), true);
console.log("Dry-hop exception history checks passed");
