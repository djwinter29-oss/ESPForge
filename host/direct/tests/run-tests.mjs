// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const files = readdirSync(root, { recursive: true }).filter(path => path.endsWith(".test.mjs")).sort()
  .map(path => fileURLToPath(new URL(path.replaceAll("\\", "/"), root)));
if (!files.length) throw new Error("No Direct JavaScript tests found");

const coverage = ["--experimental-test-coverage", "--test-coverage-lines=90", "--test-coverage-branches=80",
  "--test-coverage-functions=85"];
const result = spawnSync(process.execPath, ["--test", ...coverage, ...process.argv.slice(2), ...files],
  { encoding: "utf8" });
if (result.error) throw result.error;
if (result.signal) throw new Error(`Direct tests terminated by ${result.signal}`);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) {
  process.exitCode = result.status;
} else {
  const rows = [...result.stdout.matchAll(/^\s*ℹ\s+(\S+\.mjs)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/gm)]
    .map(([, file, lines, branches, functions]) => ({
      file, lines: Number(lines), branches: Number(branches), functions: Number(functions),
    }));
  if (!rows.length) throw new Error("Node did not report per-file Direct coverage");
  const underBudget = rows.filter(row => row.lines < 80 || row.branches < 50 || row.functions < 50);
  if (underBudget.length) {
    console.error("Per-file coverage must be at least 80% lines, 50% branches, and 50% functions:");
    for (const row of underBudget) {
      console.error(`  ${row.file}: lines ${row.lines}%, branches ${row.branches}%, functions ${row.functions}%`);
    }
    process.exitCode = 1;
  }
}
