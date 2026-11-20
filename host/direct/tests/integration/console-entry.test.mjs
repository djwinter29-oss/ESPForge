// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createDocument } from "../support/dom.mjs";

test("console entry validates its owning dashboard target before opening the relay", async t => {
  const keys = ["document", "window", "location", "fetch", "requestAnimationFrame", "crypto", "BroadcastChannel"];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { document } = createDocument();
  const handlers = new Map();
  const channels = [];
  const targetRequests = [];
  const calls = [];
  const setGlobal = (key, value) => Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value,
  });
  class Channel {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      this.closed = false;
      channels.push(this);
    }

    addEventListener(type, listener) {
      if (type === "message") this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
      if (type === "message") this.listeners.delete(listener);
    }

    postMessage(message) {
      targetRequests.push(message);
      if (message.type === "console-target") {
        queueMicrotask(() => {
          for (const listener of this.listeners) {
            listener({ data: { id: message.id, ipv4: message.ipv4, serial: message.serial } });
          }
        });
      }
    }

    close() {
      this.closed = true;
    }
  }
  const response = value => ({ ok: true, status: 200, json: async () => value });
  setGlobal("document", document);
  setGlobal("window", { addEventListener(type, handler) {
    const listeners = handlers.get(type) ?? [];
    listeners.push(handler);
    handlers.set(type, listeners);
  } });
  setGlobal("location", { search: "?source=dashboard-1&ipv4=192.168.1.9&serial=board-1", reload() {} });
  setGlobal("crypto", webcrypto);
  setGlobal("BroadcastChannel", Channel);
  setGlobal("requestAnimationFrame", callback => { callback(); return 1; });
  setGlobal("fetch", async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/console" && options.method === "POST") {
      return response({ session: "s".repeat(43), ipv4: "192.168.1.9" });
    }
    if (options.method === "GET") return response({ data: "", closed: true });
    return response({});
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  await import(`../../web/js/console.mjs?entry=${Date.now()}-${Math.random()}`);
  for (let attempt = 0; attempt < 10 && !calls.some(call => call.options.method === "DELETE"); attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, "zephyrforge-console-dashboard-1");
  assert.ok(targetRequests.length >= 2);
  assert.ok(targetRequests.every(request => request.type === "console-target"
    && request.ipv4 === "192.168.1.9" && request.serial === "board-1"));
  const open = calls.find(call => call.url === "/api/console" && call.options.method === "POST");
  assert.ok(open);
  assert.deepEqual(JSON.parse(open.options.body), { ipv4: "192.168.1.9" });
  assert.ok(calls.some(call => call.url === "/api/console" && call.options.method === "GET"));
  assert.ok(calls.some(call => call.url === "/api/console" && call.options.method === "DELETE"));

  for (const handler of handlers.get("pagehide") ?? []) handler();
  assert.equal(channels[0].closed, true);
});
