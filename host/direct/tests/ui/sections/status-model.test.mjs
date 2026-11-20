// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { deriveDashboardViewModel } from "../../../web/js/ui/sections/status-model.mjs";

test("the presentation form lock also blocks otherwise-ready MSC handoff", () => {
  const state = { connected: true, link: "usb", hardware: { capabilities: 0x96 },
    settings: { board_flags: 0x45 }, freshness: { 10: "fresh" },
    memory: { sample_valid: true, initialized: true } };
  assert.equal(deriveDashboardViewModel(state).eligibility.mscReady, true);
  assert.equal(deriveDashboardViewModel(state, true).eligibility.mscReady, false);
});

test("dashboard view model derives connection messaging and readiness without a console URL", () => {
  const disconnected = deriveDashboardViewModel({});
  assert.equal(disconnected.connection_state, "disconnected");
  assert.equal(disconnected.connection_label, "Disconnected");
  assert.equal(disconnected.status_message, "Select a ZephyrForge device");
  assert.equal(Object.hasOwn(disconnected, "console_url"), false);

  const connected = deriveDashboardViewModel({
    connected: true,
    hardware: { capabilities: 0 },
    wireless: { wifi_enabled: true, wifi_state: "connected", ipv4: "192.168.1.2" },
  });

  assert.equal(connected.connection_state, "connected");
  assert.equal(connected.connection_label, "Connected");
  assert.equal(Object.hasOwn(connected, "console_url"), false);

  for (const [link, live, rebooting] of [["usb", "USB status is live", /waiting for USB reconnection/],
    ["ble", "Bluetooth status is live", /reconnect Bluetooth after the board restarts/]]) {
    assert.equal(deriveDashboardViewModel({ connected: true, link, runtime: {} }).status_message, live);
    assert.match(deriveDashboardViewModel({ connected: true, link, reboot_pending: true }).status_message, rebooting);
  }
  assert.match(deriveDashboardViewModel({ connected: true, link: "ble", reconnecting: true }).status_message,
    /Bluetooth device reconnecting/);

  const error = deriveDashboardViewModel({ connected: true, error: "Connection failed" });
  assert.equal(error.connection_state, "connected");
  assert.equal(error.connection_label, "Connected");
  assert.equal(error.status_message, "Connection failed");

  const actionError = deriveDashboardViewModel({ connected: true, action_error: "No board was selected." });
  assert.equal(actionError.connection_state, "connected");
  assert.equal(actionError.connection_label, "Connected");
  assert.equal(actionError.status_message, "No board was selected.");
  assert.equal(actionError.status_error, true);

  const disconnectedError = deriveDashboardViewModel({ connected: false, error: "Connection failed" });
  assert.equal(disconnectedError.connection_state, "error");
  assert.equal(disconnectedError.connection_label, "Attention");
});
