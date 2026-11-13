// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleTerminal } from "../web/js/ui/console-terminal.mjs";
import { consoleTarget, serveConsoleTarget, checkConsoleTarget } from "../web/js/ui/console-target.mjs";
import { mountConsole } from "../web/js/ui/console-session.mjs";
import { createDocument } from "./support/dom.mjs";

test("Direct terminal handles native erase and bounds plain-text scrollback", () => {
  const terminal = new ConsoleTerminal();
  terminal.write("ESPForge> hx\x1b[D\x1b[Pelp\x1b[0K\x1b[?25l");
  assert.equal(terminal.lines[0], "ESPForge> help");
  terminal.write("\r\x1b[2K<script>");
  assert.deepEqual(terminal.display(), ["<script>", " ", ""]);
  terminal.write("\nline".repeat(1100));
  assert.equal(terminal.lines.length, 1000);
  terminal.write("\x1b[2J\x1b[Hready");
  assert.deepEqual(terminal.lines, ["ready"]);
});

test("console lease rejects stale, replaced and disconnected board state", async context => {
  let state = { connected: true, hardware: { serial_number: "board-a" }, freshness: { 6: "fresh" },
    wireless: { wifi_enabled: true, wifi_state: "connected", ipv4: "192.168.1.9" } };
  const target = consoleTarget(state);
  assert.deepEqual(target, { serial: "board-a", ipv4: "192.168.1.9" });
  const name = `console-test-${crypto.randomUUID()}`;
  const owner = new BroadcastChannel(name);
  const child = new BroadcastChannel(name);
  context.after(() => { owner.close(); child.close(); });
  serveConsoleTarget(owner, () => state);
  await checkConsoleTarget(child, target);
  for (const changed of [{ ...state, connected: false }, { ...state, freshness: { 6: "stale" } },
    { ...state, hardware: { serial_number: "other" } }, { ...state, wireless: { ...state.wireless, ipv4: "10.0.0.2" } }]) {
    state = changed;
    await assert.rejects(checkConsoleTarget(child, target), /fresh Wi-Fi/);
  }
});

test("Direct short writes disconnect without replay or exposing the session in URLs", async context => {
  const { document, element } = createDocument();
  const originals = new Map(["document", "window", "fetch", "requestAnimationFrame"].map(key => [key, globalThis[key]]));
  const calls = [];
  const events = new Map();
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, handler) => events.set(type, handler),
    getSelection: () => ({ toString: () => "" }) };
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "GET") return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
    return { ok: true, status: 200, json: async () => url === "/api/console/input" ? { written: 0 }
      : options.method === "POST" ? { session: "s".repeat(43), ipv4: "192.168.1.9" } : {} };
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  context.after(async () => {
    events.get("pagehide")?.();
    await tick();
    for (const [key, value] of originals) globalThis[key] = value;
  });
  mountConsole({ openUrl: "/api/console", openBody: { ipv4: "192.168.1.9" }, check: async () => {} });
  await tick();
  element("#terminal").dispatchEvent({ type: "keydown", key: "x", preventDefault() {} });
  await tick();
  const writes = calls.filter(call => call.url === "/api/console/input");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
  assert.ok(calls.every(call => !call.url.includes("s".repeat(43))));
  assert.match(element("#console-status").textContent, /not retried/);
});
