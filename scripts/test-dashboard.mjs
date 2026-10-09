import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output = mkdtempSync(join(tmpdir(), "brewery-dashboard-tests-"));
const tests = [
  "health-dashboard-model",
  "batch-timeline-model",
  "sync-status-model",
  "measurement-history-model",
  "carbonation-retest-policy",
  "plato-threshold-forecast",
  "brew-progress-display",
];

try {
  const compile = spawnSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--types",
      "node",
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--esModuleInterop",
      "--skipLibCheck",
      "--noEmitOnError",
      "--outDir",
      output,
      ...tests.map((name) => `tests/${name}.test.ts`),
    ],
    { stdio: "inherit" },
  );

  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    const run = spawnSync(
      process.execPath,
      ["--test", ...tests.map((name) => join(output, `tests/${name}.test.js`))],
      { stdio: "inherit" },
    );
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
