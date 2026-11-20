// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { consoleTarget, serveConsoleTarget, checkConsoleTarget } from "../../../web/js/ui/console/console-target.mjs";

test("console lease rejects stale, replaced and disconnected board state", async context => {
  let state = { connected: true, hardware: { serial_number: "board-a" }, freshness: { 12: "fresh" },
    wireless: { wifi_enabled: true, wifi_state: "connected", ipv4: "192.168.1.9" } };
  const target = consoleTarget(state);
  assert.deepEqual(target, { serial: "board-a", ipv4: "192.168.1.9" });
  const name = `console-test-${crypto.randomUUID()}`;
  const owner = new BroadcastChannel(name);
  const child = new BroadcastChannel(name);
  context.after(() => { owner.close(); child.close(); });
  serveConsoleTarget(owner, () => state);
  await checkConsoleTarget(child, target);
  for (const changed of [{ ...state, connected: false }, { ...state, freshness: { 12: "stale" } },
    { ...state, freshness: {} }, { ...state, freshness: { 6: "fresh" } },
    { ...state, hardware: { serial_number: "other" } },
    { ...state, wireless: { ...state.wireless, ipv4: "10.0.0.2" } }]) {
    state = changed;
    await assert.rejects(checkConsoleTarget(child, target), /fresh Wi-Fi/);
  }
});
