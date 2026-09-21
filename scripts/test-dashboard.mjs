import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output = mkdtempSync(join(tmpdir(), "brewery-dashboard-tests-"));

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
      "tests/health-dashboard-model.test.ts",
      "tests/batch-timeline-model.test.ts",
      "tests/sync-status-model.test.ts",
      "tests/measurement-history-model.test.ts",
      "tests/carbonation-retest-policy.test.ts",
    ],
    { stdio: "inherit" },
  );

  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    const run = spawnSync(
      process.execPath,
      [
        "--test",
        join(output, "tests/health-dashboard-model.test.js"),
        join(output, "tests/batch-timeline-model.test.js"),
        join(output, "tests/sync-status-model.test.js"),
        join(output, "tests/measurement-history-model.test.js"),
        join(output, "tests/carbonation-retest-policy.test.js"),
      ],
      { stdio: "inherit" },
    );
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
