// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../support/dom.mjs";

async function bootApp(t, { hostname = "localhost", response = { ok: false, status: 404 } } = {}) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    secure: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
  };
  const { document } = createDocument();
  const handlers = new Map();
  const calls = [];
  const errors = [];
  let reloads = 0;
  let disposed = false;
  globalThis.document = document;
  globalThis.window = { addEventListener(type, handler) { handlers.set(type, handler); } };
  globalThis.location = { hostname, reload() { reloads++; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { hid: new EventTarget() } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: null });
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url);
    return response;
  });
  t.mock.method(console, "error", (...args) => errors.push(args));
  await import(`../../web/js/app.mjs?bootstrap=${Date.now()}-${Math.random()}`);
  await new Promise(resolve => setImmediate(resolve));
  const disposeApp = () => {
    if (disposed) return;
    handlers.get("pagehide")?.();
    disposed = true;
  };
  return {
    calls, errors, handlers, get reloads() { return reloads; }, pagehide: disposeApp,
    async dispose() {
      disposeApp();
      await new Promise(resolve => setImmediate(resolve));
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.location = saved.location;
      for (const [key, descriptor] of [["navigator", saved.navigator], ["isSecureContext", saved.secure],
        ["sessionStorage", saved.sessionStorage]]) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("app capability discovery is loopback-only, tolerates missing endpoints and reports invalid responses", async t => {
  const missing = await bootApp(t);
  assert.deepEqual(missing.calls, ["/api/console/capabilities"]);
  assert.deepEqual(missing.errors, [], "a missing optional endpoint is not an error");
  await missing.dispose();

  const remote = await bootApp(t, { hostname: "192.0.2.10" });
  assert.deepEqual(remote.calls, [], "remote pages do not discover a loopback console relay");
  remote.pagehide();
  remote.handlers.get("pageshow")?.({ persisted: true });
  assert.equal(remote.reloads, 1, "a restored page reloads after pagehide disposed its session");
  await remote.dispose();

  const invalid = await bootApp(t, { response: { ok: false, status: 500 } });
  assert.deepEqual(invalid.calls, ["/api/console/capabilities"]);
  assert.equal(invalid.errors.length, 1, "invalid local capability responses are surfaced");
  assert.match(invalid.errors[0][0], /console relay discovery failed/);
  await invalid.dispose();
});
