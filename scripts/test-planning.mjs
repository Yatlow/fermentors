import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const output = mkdtempSync(join(tmpdir(), "brewery-planning-tests-"));
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
      "tests/planning-workflow.test.ts",
      "tests/shipment-picking-regression.test.ts",
      "tests/planning-weekly-regression.test.ts",
      "tests/planning-style-targets.test.ts",
      "tests/shipment-actuals-regression.test.ts",
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
        join(output, "tests/planning-workflow.test.js"),
        join(output, "tests/shipment-picking-regression.test.js"),
        join(output, "tests/planning-weekly-regression.test.js"),
        join(output, "tests/planning-style-targets.test.js"),
        join(output, "tests/shipment-actuals-regression.test.js"),
      ],
      { stdio: "inherit" },
    );
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
