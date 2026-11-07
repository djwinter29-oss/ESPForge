// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { deriveDashboardViewModel } from "../../../web/js/ui/sections/status-model.mjs";

test("dashboard view model derives connection messaging and readiness without a console URL", () => {
  const disconnected = deriveDashboardViewModel({});
  assert.equal(disconnected.connection_state, "disconnected");
  assert.equal(disconnected.connection_label, "Disconnected");
  assert.equal(disconnected.status_message, "Select an ESPForge device");
  assert.equal(Object.hasOwn(disconnected, "console_url"), false);

  const connected = deriveDashboardViewModel({
    connected: true,
    hardware: { capabilities: 0 },
    wireless: { wifi_enabled: true, wifi_state: "connected", ipv4: "192.168.1.2" },
  });

  assert.equal(connected.connection_state, "connected");
  assert.equal(connected.connection_label, "Connected");
  assert.equal(Object.hasOwn(connected, "console_url"), false);

  const error = deriveDashboardViewModel({ connected: true, error: "Connection failed" });
  assert.equal(error.connection_state, "error");
  assert.equal(error.connection_label, "Attention");
  assert.equal(error.status_message, "Connection failed");
});
