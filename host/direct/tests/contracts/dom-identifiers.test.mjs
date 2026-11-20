// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

test("HTML IDs are unique and static JavaScript selectors resolve to a page element", () => {
  const root = new URL("../../", import.meta.url);
  const pages = ["web/index.html", "web/console.html"];
  const ids = new Set();
  for (const page of pages) {
    const html = readFileSync(new URL(page, root), "utf8");
    const found = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
    assert.equal(new Set(found).size, found.length, `${page} contains duplicate IDs`);
    found.forEach(id => ids.add(id));
  }
  const modules = readdirSync(new URL("web/js/", root), { recursive: true })
    .filter(path => path.endsWith(".mjs"));
  const missing = new Set();
  for (const path of modules) {
    const source = readFileSync(new URL(`web/js/${path}`, root), "utf8");
    for (const [, selector] of source.matchAll(/(?:queryElement|querySelector|querySelectorAll)\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (selector.includes("${")) continue;
      for (const [, id] of selector.matchAll(/#([a-z][a-z0-9-]*)/g)) {
        if (!ids.has(id)) missing.add(`${path}: #${id}`);
      }
    }
    for (const [, id] of source.matchAll(/\b(?:element|button|input|select|el)\(\s*["'`]([a-z][a-z0-9-]+)["'`]\s*\)/g)) {
      if (!ids.has(id)) missing.add(`${path}: ${id}`);
    }
  }
  assert.deepEqual([...missing], [], "selectors and shared element helpers must use declared page IDs");
});
