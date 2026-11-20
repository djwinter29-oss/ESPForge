// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleTerminal } from "../../../web/js/ui/console/console-terminal.mjs";

test("Direct terminal handles native erase and bounds plain-text scrollback", () => {
  const terminal = new ConsoleTerminal();
  terminal.write("ZephyrForge> hx\x1b[D\x1b[Pelp\x1b[0K\x1b[?25l");
  assert.equal(terminal.lines[0], "ZephyrForge> help");
  terminal.write("\r\x1b[2K<script>");
  assert.deepEqual(terminal.display(), ["<script>", " ", ""]);
  terminal.write("\nline".repeat(1100));
  assert.equal(terminal.lines.length, 1000);
  terminal.write("\x1b[2J\x1b[Hready");
  assert.deepEqual(terminal.lines, ["ready"]);
});
