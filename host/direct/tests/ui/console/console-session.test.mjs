// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { mountConsole } from "../../../web/js/ui/console/console-session.mjs";
import { createDocument } from "../../support/dom.mjs";

test("Direct short writes disconnect without replay or exposing the session in URLs", async context => {
  const { document, element } = createDocument();
  const originals = new Map(["document", "window", "fetch", "requestAnimationFrame"]
    .map(key => [key, globalThis[key]]));
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

async function setupConsole(t, respond, { check = async () => {}, confirm = () => true } = {}) {
  const { document, element } = createDocument();
  const originals = new Map(["document", "window", "fetch", "requestAnimationFrame", "location"]
    .map(key => [key, globalThis[key]]));
  const events = new Map();
  const calls = [];
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, handler) => events.set(type, handler),
    getSelection: () => ({ toString: () => "" }), confirm };
  globalThis.location = { reload() {} };
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return respond(url, options);
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  t.after(async () => {
    events.get("pagehide")?.();
    await tick();
    for (const [key, value] of originals) globalThis[key] = value;
  });
  mountConsole({ openUrl: "/api/console", openBody: { ipv4: "192.168.1.9" }, check });
  await tick();
  return { element, calls, events, tick };
}

const response = value => ({ ok: true, status: 200, json: async () => value });
const opened = { session: "s".repeat(43), ipv4: "192.168.1.9" };
const heldRead = (_url, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
});

test("console validates relay packets, renders output and disconnects on a closed board", async t => {
  const calls = [];
  const app = await setupConsole(t, async (url, options) => {
    if (url === "/api/console" && options.method === "POST") return response(opened);
    if (options.method === "GET") return response({ data: "aGVsbG8=", closed: true });
    calls.push({ url, options });
    return response({});
  });
  await app.tick();
  assert.match(app.element("#terminal").textContent, /hello/);
  assert.match(app.element("#console-status").textContent, /board closed the console/);
  assert.equal(calls.filter(call => call.options.method === "DELETE").length, 1);
});

test("console paste confirms newlines and enforces the UTF-8 queue limit", async t => {
  let releaseWrite;
  let confirm = false;
  const app = await setupConsole(t, async (url, options) => {
    if (options.method === "POST" && url === "/api/console") return response(opened);
    if (options.method === "GET") return heldRead(url, options);
    if (options.method === "POST" && url === "/api/console/input") {
      return new Promise(resolve => { releaseWrite = () => resolve(response({ written: 7 })); });
    }
    return response({});
  }, { confirm: () => confirm });
  const terminal = app.element("#terminal");
  await app.tick();
  const cancelPaste = { type: "paste", clipboardData: { getData: () => "one\ntwo" },
    preventDefault() { this.defaultPrevented = true; } };
  terminal.dispatchEvent(cancelPaste);
  assert.equal(cancelPaste.defaultPrevented, true);
  assert.equal(app.calls.some(call => call.url === "/api/console/input"), false);

  confirm = true;
  terminal.dispatchEvent({ type: "paste", clipboardData: { getData: () => "one\ntwo" },
    preventDefault() {} });
  await app.tick();
  const write = app.calls.find(call => call.url === "/api/console/input");
  assert.equal(atob(JSON.parse(write.body).data), "one\rtwo");
  terminal.dispatchEvent({ type: "paste", clipboardData: { getData: () => "x".repeat(1025) },
    preventDefault() {} });
  assert.match(app.element("#console-status").textContent, /1024-byte queue limit/);
  releaseWrite();
  await app.tick();
});

test("console disconnects when target checks or the relay handshake fail", async t => {
  const checked = await setupConsole(t, async () => {
    throw new Error("target changed");
  }, { check: async () => { throw new Error("target changed"); } });
  await checked.tick();
  assert.match(checked.element("#console-status").textContent, /Cannot connect.*target changed/);
  assert.equal(checked.calls.some(call => call.method === "POST"), false);

  const malformed = await setupConsole(t, async () => response({ session: "short", ipv4: "192.168.1.9" }));
  await malformed.tick();
  assert.match(malformed.element("#console-status").textContent, /Malformed console connection/);
  assert.equal(malformed.calls.some(call => call.method === "DELETE"), false,
    "an invalid session token is never sent back to the relay");
});
