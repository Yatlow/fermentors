import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const asModuleUrl = (source) =>
  "data:text/javascript;base64," +
  Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText).toString("base64");

const helper = asModuleUrl(read("../src/SERVICES/brewing/materialSheetWriteMapping.ts"));
const tests = read("../tests/brew-material-sheet-rows.test.ts")
  .replace(
    '"../src/SERVICES/brewing/materialSheetWriteMapping.ts"',
    JSON.stringify(helper),
  );
await import(asModuleUrl(tests));
