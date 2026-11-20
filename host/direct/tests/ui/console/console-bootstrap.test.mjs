// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { REPORT } from "../../../web/js/protocol/constants.mjs";
import { createConsoleBootstrap } from "../../../web/js/ui/console/console-bootstrap.mjs";

const state = () => ({
  connected: true,
  freshness: { [REPORT.WIRELESS]: "fresh" },
  hardware: { serial_number: "board-1" },
  wireless: { wifi_enabled: true, wifi_state: "connected", ipv4: "192.168.1.2" },
});
const response = (status, available = true) => ({
  status, ok: status >= 200 && status < 300, json: async () => ({ available }),
});

test("console bootstrap skips remote and missing optional endpoints", async () => {
  let fetches = 0;
  const bootstrap = createConsoleBootstrap({
    localServer: false, fetchCapabilities: async () => { fetches++; return response(200); },
    createChannel: () => { throw new Error("remote pages must not open a channel"); },
    createSource: () => "unused", getState: state,
  });
  assert.equal(await bootstrap.start(), false);
  assert.equal(fetches, 0);
  assert.equal(bootstrap.consoleUrl(state()), null);
  bootstrap.dispose();

  const missing = createConsoleBootstrap({
    localServer: true, fetchCapabilities: async () => response(404),
    createChannel: () => { throw new Error("missing endpoint must not open a channel"); },
    createSource: () => "unused", getState: state,
  });
  assert.equal(await missing.start(), false);
  assert.equal(missing.consoleUrl(state()), null);
  missing.dispose();
});

test("console bootstrap exposes only the fresh board target and closes its channel on disposal", async () => {
  const names = [];
  let closed = 0;
  const bootstrap = createConsoleBootstrap({
    localServer: true, fetchCapabilities: async () => response(200),
    createChannel: name => {
      names.push(name);
      return { addEventListener() {}, postMessage() {}, close() { closed++; } };
    },
    createSource: () => "session-1", getState: state,
  });
  assert.equal(await bootstrap.start(), true);
  assert.deepEqual(names, ["zephyrforge-console-session-1"]);
  const url = new URL(bootstrap.consoleUrl(state()), "http://localhost");
  assert.equal(url.pathname, "/console.html");
  assert.equal(url.searchParams.get("source"), "session-1");
  assert.equal(url.searchParams.get("ipv4"), "192.168.1.2");
  assert.equal(url.searchParams.get("serial"), "board-1");
  assert.equal(bootstrap.consoleUrl({ ...state(), connected: false }), null);
  bootstrap.dispose();
  assert.equal(closed, 1);
  assert.equal(bootstrap.consoleUrl(state()), null);
});

test("console bootstrap reports invalid capability responses and ignores late completion after disposal", async () => {
  const invalid = createConsoleBootstrap({
    localServer: true, fetchCapabilities: async () => response(200, false),
    createChannel: () => { throw new Error("invalid response must not open a channel"); },
    createSource: () => "unused", getState: state,
  });
  await assert.rejects(invalid.start(), /Invalid console capability response/);
  invalid.dispose();

  let resolveResponse;
  const pending = createConsoleBootstrap({
    localServer: true, fetchCapabilities: () => new Promise(resolve => { resolveResponse = resolve; }),
    createChannel: () => { throw new Error("disposed bootstrap must not open a channel"); },
    createSource: () => "unused", getState: state,
  });
  const starting = pending.start();
  pending.dispose();
  resolveResponse(response(200));
  assert.equal(await starting, false);
});
