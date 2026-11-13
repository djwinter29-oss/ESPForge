// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { withDocument, snapshot } from "../../support/view.mjs";
import { deriveDashboardViewModel } from "../../../web/js/ui/sections/status-model.mjs";
import { deriveDeviceViewModel } from "../../../web/js/ui/sections/device.mjs";

test("module memory keeps PSRAM separate from SRAM and unavailable flash unknown", () => withDocument((el, renderStatus) => {
  const state = snapshot();
  state.hardware = { ...state.hardware, psram_total_bytes: 8 << 20, psram_reserved_bytes: 1 << 20,
    flash_total_bytes: 16 << 20 };
  renderStatus(state);
  assert.equal(el("#ram-usage").textContent, "64.0 / 512 KiB (12.5%)");
  assert.equal(el("#psram-usage").textContent, "1.0 / 8.0 MiB (12.5%)");
  assert.equal(el("#flash-capacity").textContent, "16.0 MiB");
  state.hardware.psram_reserved_bytes = 16 << 20;
  state.hardware.flash_total_bytes = null;
  renderStatus(state);
  assert.equal(el("#psram-usage").textContent, "--");
  assert.equal(el("#flash-capacity").textContent, "--");
}));

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
  state.settings = { ...state.settings, board_flags: 0x45, card_detect_gpio: 8 };
  renderStatus(state);
  assert.equal(el("#board-storage-pins").replaceCount, 3);
  assert.equal(el("#board-storage-pins").children[0].children.at(-1).textContent, "Card detect");
  assert.equal(el("#board-storage-pins").children[1].children.at(-1).textContent, "GPIO8");
}));

test("identity RAM stays build accounting while stale inputs show no current values", () =>
  withDocument((el, renderStatus) => {
  const state = snapshot();
  state.runtime = { uptime_ms: 9007199254740993n, system_clock_hz: 240000000,
    cpu_usage_core0_basis_points: 1234 };
  renderStatus(state);
  assert.equal(el("#ram-usage").textContent, "64.0 / 512 KiB (12.5%)");
  assert.equal(el("#board-model").textContent, "ESP32-S3-DevKitC-1 (ESP32-S3)");
  assert.equal(el("#product-name").textContent, "ESPForge (SDMMC)");
  assert.equal(el("#identity-clock").textContent, "240 MHz");
  assert.equal(el("#cpu-usage-core0").textContent, "12.3% / --");
  assert.match(el("#uptime").textContent, /104249991d/);
  assert.equal(el("#board-reset-cause").textContent, "Power-on");
  const rows = id => el(id).children.map(row => row.children.map(cell => cell.textContent));
  assert.equal(el("#board-uart-title").textContent, "Monitor UART0");
  assert.deepEqual(rows("#board-uart"), [["TX", "RX"], ["GPIO43", "GPIO44"]]);
  assert.equal(el("#board-storage-title").textContent, "Storage (SDMMC)");
  assert.deepEqual(rows("#board-storage-pins"),
    [["CLK", "CMD", "DAT0", "DAT1", "DAT2", "DAT3"], ["GPIO12", "GPIO11", "GPIO13", "GPIO14", "GPIO15", "GPIO10"]]);
  assert.ok(el("#board-storage-pins").children[0].children.every(cell => cell.scope === "col"));
  assert.deepEqual(el("#settings-clock").children.map(option => option.value), ["0", "80", "160", "240"]);
  state.runtime = null; state.memory = null;
  state.freshness = { 3: "stale", 10: "stale" };
  renderStatus(state);
  assert.equal(el("#identity-clock").textContent, "--");
  assert.equal(el("#cpu-usage-core0").textContent, "-- / --");
  assert.equal(el("#ram-usage").textContent, "64.0 / 512 KiB (12.5%)");
  assert.equal(el("#telemetry-freshness").textContent, "telemetry: stale");
  assert.equal(el("#storage-freshness").textContent, "storage: stale");
}));

test("service load shows each core without replacing unavailable values with zero", () => {
  for (const [core0, core1, expected] of [
    [310, null, "3.1% / --"], [0, null, "0.0% / --"], [null, 1234, "-- / 12.3%"],
    [310, 0, "3.1% / 0.0%"], [null, null, "-- / --"], [undefined, undefined, "-- / --"],
  ]) {
    const model = deriveDeviceViewModel({ ...snapshot(),
      runtime: { cpu_usage_core0_basis_points: core0, cpu_usage_core1_basis_points: core1 } });
    assert.equal(model.text["cpu-usage-core0"], expected);
  }
});

test("device rendering reuses the supplied dashboard presentation snapshot", () => {
  const state = { connected: true };
  const dashboard = deriveDashboardViewModel(state, true);
  const device = deriveDeviceViewModel(state, dashboard);
  assert.equal(device.eligibility, dashboard.eligibility, "render-local readiness is not derived again");
  assert.equal(device.eligibility.blocked, true, "the form lock survives section composition");
  assert.equal(device.connection_label, dashboard.connection_label);
});
