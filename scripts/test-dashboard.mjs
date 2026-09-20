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
      "tests/bottom-carbonation-recommendation.test.ts",
      "tests/carbonation-retest-policy.test.ts",
      "tests/pressure-prediction-v6.test.ts",
      "tests/pressure-prediction-v6-backtest.test.ts",
      "tests/pressure-prediction-v7.test.ts",
      "tests/pressure-prediction-v7-backtest.test.ts",
      "tests/pressure-prediction-v8.test.ts",
      "tests/pressure-prediction-v8-backtest.test.ts",
      "tests/pressure-prediction-v9-physics.test.ts",
      "tests/pressure-prediction-v9-validation.test.ts",
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
        join(output, "tests/bottom-carbonation-recommendation.test.js"),
        join(output, "tests/carbonation-retest-policy.test.js"),
        join(output, "tests/pressure-prediction-v6.test.js"),
        join(output, "tests/pressure-prediction-v6-backtest.test.js"),
        join(output, "tests/pressure-prediction-v7.test.js"),
        join(output, "tests/pressure-prediction-v7-backtest.test.js"),
        join(output, "tests/pressure-prediction-v8.test.js"),
        join(output, "tests/pressure-prediction-v8-backtest.test.js"),
        join(output, "tests/pressure-prediction-v9-physics.test.js"),
        join(output, "tests/pressure-prediction-v9-validation.test.js"),
      ],
      { stdio: "inherit" },
    );
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
