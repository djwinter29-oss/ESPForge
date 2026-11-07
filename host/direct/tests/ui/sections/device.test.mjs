// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { withDocument, snapshot } from "../../support/view.mjs";
import { deriveDashboardViewModel } from "../../../web/js/ui/sections/status-model.mjs";
import { deriveDeviceViewModel } from "../../../web/js/ui/sections/device.mjs";

test("board pin tables are reused until the displayed configuration changes", () => withDocument((el, renderStatus) => {
  const state = snapshot();
  renderStatus(state);
  const uartRows = el("#board-uart").children;
  const storageRows = el("#board-storage-pins").children;
  assert.equal(el("#board-uart").replaceCount, 1);
  assert.equal(el("#board-storage-pins").replaceCount, 1);

  renderStatus(snapshot());
  assert.strictEqual(el("#board-uart").children, uartRows);
  assert.strictEqual(el("#board-storage-pins").children, storageRows);
  assert.equal(el("#board-uart").replaceCount, 1);

  state.settings = { ...state.settings, reset_cause: 2 };
  renderStatus(state);
  assert.equal(el("#board-uart").replaceCount, 2);
  assert.equal(el("#board-storage-pins").replaceCount, 2);
}));

test("identity RAM stays build accounting while stale inputs show no current values", () =>
  withDocument((el, renderStatus) => {
  const state = snapshot();
  state.runtime = { uptime_ms: 9007199254740993n, system_clock_hz: 240000000,
    cpu_usage_core0_basis_points: 1234 };
  renderStatus(state);
  assert.equal(el("#ram-usage").textContent, "64.0 / 512 KiB (12.5%)");
  assert.equal(el("#board-model").textContent, "ESP32-S3-DevKitC-1 (ESP32-S3)");
  assert.equal(el("#product-name").textContent, "ESPForge (SPI)");
  assert.equal(el("#identity-clock").textContent, "240 MHz");
  assert.equal(el("#cpu-usage-core0").textContent, "12.3%");
  assert.match(el("#uptime").textContent, /104249991d/);
  assert.equal(el("#board-reset-cause").textContent, "Power-on");
  const rows = id => el(id).children.map(row => row.children.map(cell => cell.textContent));
  assert.equal(el("#board-uart-title").textContent, "Monitor UART0");
  assert.deepEqual(rows("#board-uart"), [["TX", "RX"], ["GPIO43", "GPIO44"]]);
  assert.equal(el("#board-storage-title").textContent, "Storage (SPI)");
  assert.deepEqual(rows("#board-storage-pins"), [["CLK", "MOSI", "MISO", "CS"], ["GPIO12", "GPIO11", "GPIO13", "GPIO10"]]);
  assert.ok(el("#board-storage-pins").children[0].children.every(cell => cell.scope === "col"));
  assert.deepEqual(el("#settings-clock").children.map(option => option.value), ["0", "80", "160", "240"]);
  state.runtime = null; state.memory = null;
  state.freshness = { 3: "stale", 10: "stale" };
  renderStatus(state);
  assert.equal(el("#identity-clock").textContent, "--");
  assert.equal(el("#cpu-usage-core0").textContent, "--");
  assert.equal(el("#ram-usage").textContent, "64.0 / 512 KiB (12.5%)");
  assert.equal(el("#telemetry-freshness").textContent, "telemetry: stale");
  assert.equal(el("#storage-freshness").textContent, "storage: stale");
}));

test("device rendering reuses the supplied dashboard presentation snapshot", () => {
  const state = { connected: true };
  const dashboard = deriveDashboardViewModel(state, true);
  const device = deriveDeviceViewModel(state, dashboard);
  assert.equal(device.eligibility, dashboard.eligibility, "render-local readiness is not derived again");
  assert.equal(device.eligibility.blocked, true, "the form lock survives section composition");
  assert.equal(device.connection_label, dashboard.connection_label);
});
