// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleTerminal, consoleKey } from "../../src/js/console-terminal.mjs";
import { mountConsole } from "../../src/js/console-session.mjs";
import { domFixture } from "../support/dom-fixture.mjs";

test("native erase, insertion and cursor sequences render text safely and clear scrollback", () => {
  const terminal = new ConsoleTerminal();
  terminal.write("ESPForge> help\r\nold output\r\nESPForge> hx");
  terminal.write("\x1b[D\x1b[Pelp\x1b[0");
  terminal.write("K\x1b[?25l\x1b[31m");
  assert.equal(terminal.lines.at(-1), "ESPForge> help");
  terminal.write("\r\x1b[2K<script>");
  assert.equal(terminal.display().join(""), "ESPForge> help\nold output\n<script> ");
  assert.equal(terminal.lines.at(-1), "<script>");
  terminal.write("\x1b[2J\x1b[Hnew prompt");
  assert.deepEqual(terminal.lines, ["new prompt"]);
  terminal.write("\nline".repeat(1100));
  assert.equal(terminal.lines.length, 1000);
  assert.equal(terminal.row, 999);
  terminal.write("x".repeat(1000));
  assert.ok(terminal.lines.at(-1).length <= 512);
  assert.equal(consoleKey({ key: "c", ctrlKey: true }), "\x03");
  assert.equal(consoleKey({ key: "ArrowLeft" }), "\x1b[D");
});

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(context, { written = 5, failWrite = false } = {}) {
  const { document, el } = domFixture();
  const globals = new Map(["document", "window", "requestAnimationFrame", "fetch"].map(key => [key, globalThis[key]]));
  const listeners = new Map();
  const calls = [];
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, handler) => listeners.set(type, handler),
    getSelection: () => ({ toString: () => "" }), confirm: () => false };
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "GET") {
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort",
        () => reject(new Error("Aborted")), { once: true }));
    }
    if (url === "/api/console/input" && failWrite) throw new Error("Lost acknowledgement");
    const result = url === "/api/console/input" ? { written }
      : options.method === "POST" ? { session: "a".repeat(43), ipv4: "192.168.1.9" } : {};
    return { ok: true, status: 200, json: async () => result };
  };
  context.after(async () => {
    listeners.get("pagehide")?.();
    await tick();
    for (const [key, value] of globals) globalThis[key] = value;
  });
  mountConsole({ openUrl: "/api/console?board=a", openBody: {} });
  return { calls, el, listeners };
}

test("short and uncertain writes close without replay and keep session credentials out of URLs", async context => {
  const { calls, el } = fixture(context, { written: 2 });
  await tick();
  await el("#terminal").fire("paste", { clipboardData: { getData: () => "help" } });
  await tick();
  const writes = calls.filter(call => call.url === "/api/console/input");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body), { data: "aGVscA==" });
  assert.equal(writes[0].headers["X-Console-Session"], "a".repeat(43));
  assert.equal(writes[0].method, "POST");
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
  assert.ok(calls.every(call => !call.url.includes("a".repeat(43))));
  assert.match(el("#console-status").textContent, /not retried/);
  await el("#terminal").fire("keydown", { key: "Enter" });
  assert.equal(calls.filter(call => call.url === "/api/console/input").length, 1);
});

test("multiline paste requires confirmation, oversized input is rejected, and Shift+Tab escapes focus", async context => {
  const { calls, el } = fixture(context);
  await tick();
  await el("#terminal").fire("paste", { clipboardData: { getData: () => "help\n" } });
  await el("#terminal").fire("paste", { clipboardData: { getData: () => "x".repeat(1025) } });
  const event = { key: "Tab", shiftKey: true };
  await el("#terminal").fire("keydown", event);
  assert.equal(event.defaultPrevented, undefined);
  assert.equal(calls.filter(call => call.url === "/api/console/input").length, 0);
  assert.match(el("#console-status").textContent, /not sent/);
});

test("a lost write acknowledgement never retries input", async context => {
  const { calls, el } = fixture(context, { failWrite: true });
  await tick();
  await el("#terminal").fire("keydown", { key: "x" });
  await tick();
  assert.equal(calls.filter(call => call.url === "/api/console/input").length, 1);
  assert.match(el("#console-status").textContent, /may have reached/);
});
