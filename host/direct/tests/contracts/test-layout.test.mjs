// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("module test paths identify their source and helpers remain outside runnable suites", () => {
  const root = new URL("../", import.meta.url);
  const suites = readdirSync(root, { recursive: true }).filter(path => path.endsWith(".test.mjs"));
  assert.ok(suites.length > 0);
  for (const entry of suites) {
    const path = entry.replaceAll("\\", "/");
    assert.ok(!/^(support|browser|types)\//.test(path), `${path}: not a runtime suite`);
    if (/^(integration|contracts)\//.test(path)) continue;
    const source = path.startsWith("web/")
      ? new URL(`../web/${path.slice(4).replace(".test.mjs", ".html")}`, root)
      : new URL(`../web/js/${path.replace(".test.mjs", ".mjs")}`, root);
    assert.ok(existsSync(source), `${path}: no matching source at ${source.pathname}`);
  }
});

test("the Direct type check includes the complete runtime module graph", () => {
  const config = JSON.parse(readFileSync(new URL("../types/tsconfig.json", import.meta.url), "utf8"));
  assert.ok(config.include.includes("../../web/js/**/*.mjs"));
  assert.equal(config.files, undefined, "source files are not maintained as a manual allowlist");
  assert.equal(config.compilerOptions.checkJs, true);
});

test("protocol sources have an incremental noImplicitAny check", () => {
  const config = JSON.parse(readFileSync(new URL("../types/tsconfig.protocol-strict.json", import.meta.url), "utf8"));
  assert.deepEqual(config.include, ["../../web/js/protocol/*.mjs"]);
  assert.equal(config.compilerOptions.noImplicitAny, true);
});

test("dashboard composition stays below its function-size budget", () => {
  const source = readFileSync(new URL("../../web/js/ui/dashboard.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export function mountDashboard(");
  const end = source.lastIndexOf("\n}");
  assert.ok(start >= 0 && end > start, "mountDashboard remains the dashboard composition entry point");
  const lines = source.slice(start, end + 2).split("\n").length;
  assert.ok(lines <= 170, `mountDashboard is ${lines} lines; maximum is 170`);
});
