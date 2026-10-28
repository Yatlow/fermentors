import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const appEntry = read("../src/main.tsx");
const previewWorkflow = read("../.github/workflows/firebase-hosting-pull-request.yml");

test("normal PR preview root must show the private brewery application", () => {
  assert.match(appEntry,
    /import\.meta\.env\.VITE_DEPLOY_ENV === 'preview' && import\.meta\.env\.VITE_QUALITY_REPORT_ONLY_PREVIEW === 'true' && location\.pathname === '\/'/);
  assert.match(previewWorkflow,
    /VITE_QUALITY_REPORT_ONLY_PREVIEW: \$\{\{ github\.event\.pull_request\.number == 252 && 'true' \|\| 'false' \}\}/);
  assert.match(appEntry, /import\('\.\/App'\)/);
});

test("public issue form remains reachable at its explicit route", () => {
  assert.match(appEntry, /\/report-issue/);
  assert.match(appEntry, /import\('\.\/public-report\/ReportPage'\)/);
});
