// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { queryElement, setText } from "../dom.mjs";
import { unknown } from "../messages.mjs";
import { deriveDashboardViewModel } from "./status-model.mjs";

function uptimeLabel(milliseconds) {
  if (typeof milliseconds === "bigint") {
    const seconds = milliseconds / 1000n;
    const days = seconds / 86400n;
    const hours = seconds % 86400n / 3600n;
    const minutes = seconds % 3600n / 60n;
    return days > 0n ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds % 60n}s`;
  }
  if (!Number.isFinite(milliseconds)) return "--";
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds % 60}s`;
}

export function deriveDeviceViewModel(state, dashboard = deriveDashboardViewModel(state)) {
  const hardware = state.hardware;
  const runtime = state.runtime;
  const config = state.settings;
  const ramUsed = hardware?.ram_reserved_bytes;
  const ramTotal = hardware?.ram_total_bytes;
  const signals = ["CLK", "MOSI", "MISO", "CS"];
  const pin = value => !config ? "--" : value === 255 || value == null ? "Unassigned" : `GPIO${value}`;
  return {
    ...dashboard,
    active: Boolean(state.connected && runtime),
    error: Boolean(state.error),
    freshness: [[3, "telemetry"], [10, "storage"]].map(([id, label]) => ({
      label, hidden: state.freshness?.[id] === "fresh", text: `${label}: ${state.freshness?.[id] ?? "unavailable"}`,
    })),
    pins: {
      signature: JSON.stringify([config?.monitor_uart_index, config?.monitor_uart_tx_gpio,
        config?.monitor_uart_rx_gpio, config?.storage_gpios, config?.reset_cause]),
      uart: [["TX", "RX"], [pin(config?.monitor_uart_tx_gpio), pin(config?.monitor_uart_rx_gpio)]],
      storage: [signals, signals.map((_, index) => pin(config?.storage_gpios?.[index]))],
    },
    text: {
      "product-name": hardware ? `${hardware.product_name} (SPI)` : "--",
      "board-model": hardware ? `${hardware.board_name ?? unknown("board", hardware.board_model)} `
        + `(${hardware.mcu ?? unknown("MCU", hardware.mcu_id)})` : "--",
      "firmware-version": hardware?.firmware_version ?? "Unknown",
      "identity-clock": runtime
        ? `${(runtime.system_clock_hz / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} MHz` : "--",
      "cpu-usage-core0": runtime?.cpu_usage_core0_basis_points == null
        ? "--" : `${(runtime.cpu_usage_core0_basis_points / 100).toFixed(1)}%`,
      "ram-usage": Number.isSafeInteger(ramTotal) && ramTotal > 0 && Number.isSafeInteger(ramUsed)
        && ramUsed >= 0 && ramUsed <= ramTotal
        ? `${(ramUsed / 1024).toFixed(1)} / ${(ramTotal / 1024).toFixed(0)} KiB`
          + ` (${(ramUsed * 100 / ramTotal).toFixed(1)}%)` : "--",
      serial: hardware?.serial_number || "--",
      uptime: runtime ? uptimeLabel(runtime.uptime_ms) : "--",
      temperature: runtime?.temperature_valid ? `${(runtime.temperature_centidegrees / 100).toFixed(2)} °C` : "--",
      "board-uart-title": config && config.monitor_uart_index !== 255
        ? `Monitor UART${config.monitor_uart_index}` : "Monitor UART",
      "board-storage-title": config ? "Storage (SPI)" : "Storage",
      "board-reset-cause": config
        ? ["Unknown", "Power-on", "Watchdog", "Software request"][config.reset_cause]
          ?? `Unassigned (${config.reset_cause})` : "--",
    },
  };
}

export function renderDevice(state, dashboard) {
  const model = deriveDeviceViewModel(state, dashboard);
  setText({ ...model.text, "connection-label": model.connection_label, "status-message": model.status_message });
  queryElement("#connection").dataset.state = model.connection_state;
  queryElement(".status-line").dataset.error = String(model.error);
  queryElement(".status-line").dataset.active = String(model.active);
  for (const status of model.freshness) {
    const element = queryElement(`#${status.label}-freshness`);
    element.textContent = status.text;
    element.hidden = status.hidden;
  }
  const uart = queryElement("#board-uart");
  if (uart.dataset.boardConfiguration === model.pins.signature) return;
  const tables = /** @type {[string, [string[], string[]]][]} */ ([["board-uart", model.pins.uart],
    ["board-storage-pins", model.pins.storage]]);
  for (const [id, [labels, pins]] of tables) {
    const headings = document.createElement("tr");
    const values = document.createElement("tr");
    labels.forEach((label, index) => {
      const heading = document.createElement("th");
      heading.scope = "col";
      heading.textContent = label;
      const cell = document.createElement("td");
      cell.textContent = pins[index];
      headings.append(heading);
      values.append(cell);
    });
    queryElement(`#${id}`).replaceChildren(headings, values);
  }
  uart.dataset.boardConfiguration = model.pins.signature;
}
