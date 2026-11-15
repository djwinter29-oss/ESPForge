// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { belowCoverageFloors, parseLcov } from "./support/coverage-lcov.mjs";

const root = new URL("./", import.meta.url);
const runtimeRoot = fileURLToPath(new URL("../web/js/", root));
const typeOnlyModules = new Set(["transport/transport.mjs"]);
const runtimeFiles = readdirSync(runtimeRoot, { recursive: true })
  .filter(path => path.endsWith(".mjs") && !typeOnlyModules.has(path.replaceAll("\\", "/")))
  .map(path => resolve(runtimeRoot, path).replaceAll("\\", "/"));
const files = readdirSync(root, { recursive: true }).filter(path => path.endsWith(".test.mjs")).sort()
  .map(path => fileURLToPath(new URL(path.replaceAll("\\", "/"), root)));
if (!files.length) throw new Error("No Direct JavaScript tests found");

const coverage = ["--experimental-test-coverage", "--test-coverage-lines=90", "--test-coverage-branches=80",
  "--test-coverage-functions=85", "--test-coverage-include=**/host/direct/web/js/**/*.mjs"];
const temp = mkdtempSync(join(tmpdir(), "espforge-direct-coverage-"));
try {
  const lcovPath = join(temp, "coverage.info");
  const args = ["--test", ...coverage, "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`, ...process.argv.slice(2), ...files];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Direct tests terminated by ${result.signal}`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    const lcov = parseLcov(readFileSync(lcovPath, "utf8"));
    const runtimeModule = /(?:^|\/)host\/direct\/web\/js\/.+\.mjs$/;
    const rows = lcov.filter(record => runtimeModule.test(record.file));
    if (!rows.length) throw new Error("Node did not report LCOV coverage for Direct runtime modules");
    const nonRuntime = lcov.filter(record => !runtimeModule.test(record.file));
    if (nonRuntime.length) {
      const files = nonRuntime.map(record => record.file).join(", ");
      throw new Error(`Node coverage included non-runtime files: ${files}`);
    }
    const reported = new Set(rows.map(record => resolve(record.file).replaceAll("\\", "/")));
    const missing = runtimeFiles.filter(file => !reported.has(file));
    if (missing.length) {
      throw new Error(`Node did not report coverage for runtime modules: ${missing.join(", ")}`);
    }
    const underBudget = belowCoverageFloors(rows, { lines: 80, branches: 55, functions: 50 });
    if (underBudget.length) {
      console.error("Per-file coverage must be at least 80% lines, 55% branches, and 50% functions:");
      for (const row of underBudget) {
        console.error(`  ${row.file}: lines ${row.lines.toFixed(2)}%, branches ${row.branches.toFixed(2)}%, `
          + `functions ${row.functions.toFixed(2)}%`);
      }
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
