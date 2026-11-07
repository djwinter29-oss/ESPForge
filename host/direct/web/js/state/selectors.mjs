// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Pure view models derived from dashboard state; "--" always means "not reported now". */

import { RESULT_CODES } from "../protocol/constants.mjs";

/** @typedef {import("./reducer.mjs").DashboardState} DashboardState */

const UNKNOWN = "--";

/** @param {number} ms */
export function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const clock = [Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60]
    .map((value, index) => (index ? String(value).padStart(2, "0") : String(value))).join(":");
  return days ? `${days}d ${clock}` : clock;
}

/**
 * @param {number} code
 * @param {keyof typeof RESULT_CODES} table
 */
export function formatResult(code, table) {
  const meaning = /** @type {Record<number, string>} */ (RESULT_CODES[table])[code];
  return meaning ? `${code} (${meaning})` : `${code} (error)`;
}

/** @param {boolean} enabled */
const onOff = enabled => (enabled ? "Enabled" : "Disabled");

/** @param {DashboardState} state */
export function selectConnection(state) {
  if (state.link === "connecting") return { state: "connecting", label: "Connecting…" };
  if (state.link === "error") return { state: "error", label: "Error" };
  if (state.link === "connected" && state.transport) {
    return { state: state.transport.simulated ? "simulated" : "connected", label: state.transport.label };
  }
  return { state: "disconnected", label: "Disconnected" };
}

/** @param {DashboardState} state */
export function selectIdentity(state) {
  const status = state.status;
  return {
    "product-name": status?.product ?? UNKNOWN,
    "board-model": status?.board ?? UNKNOWN,
    "firmware-version": status?.firmware ?? UNKNOWN,
    "protocol-version": status ? `v${status.protocol}` : UNKNOWN,
    "link-name": state.link === "connected" && state.transport ? state.transport.label : UNKNOWN,
  };
}

/** @param {DashboardState} state */
export function selectConfiguration(state) {
  const status = state.status;
  return {
    "wifi-enabled": status ? onOff(status.wifi_enabled) : UNKNOWN,
    "ble-enabled": status ? onOff(status.ble_enabled) : UNKNOWN,
  };
}

/** @param {DashboardState} state */
export function selectDiagnostics(state) {
  const status = state.status;
  if (!status) return { uptime: UNKNOWN, "wifi-state": UNKNOWN, "wifi-result": UNKNOWN, "ble-result": UNKNOWN };
  return {
    uptime: formatUptime(status.uptime_ms),
    "wifi-state": status.wifi_connected ? "Associated" : "Not associated",
    "wifi-result": formatResult(status.wifi_error, "wifi"),
    "ble-result": formatResult(status.ble_error, "ble"),
  };
}

/** @param {DashboardState} state */
export function selectStorage(state) {
  const status = state.status;
  return {
    "memory-state": status ? (status.sd_mounted ? "Mounted" : "Not mounted") : UNKNOWN,
    "memory-result": status ? formatResult(status.sd_error, "sd") : UNKNOWN,
  };
}

/**
 * @param {DashboardState} state
 * @param {(at: number) => string} formatTime
 */
export function selectFreshness(state, formatTime) {
  if (!state.status || state.sampled_at === null) return "telemetry: unavailable";
  const source = state.transport?.simulated ? "simulated sample" : "device sample";
  return `telemetry: ${source} at ${formatTime(state.sampled_at)} · polled every second`;
}

/** @param {DashboardState} state */
export function selectControls(state) {
  const idle = state.link === "disconnected" || (state.link === "error" && !state.cleanup_pending);
  const connected = state.link === "connected";
  return {
    connect: idle,
    disconnect: connected || state.cleanup_pending,
    refresh: connected,
    wifi: connected && state.command !== "wifi" && Boolean(state.transport?.writable),
    preview: Boolean(connected && state.transport?.simulated),
  };
}

/** @param {DashboardState} state */
export function selectStatusLine(state) {
  if (state.error) {
    const next = state.cleanup_pending ? "Disconnect to release the device." : "Reconnect to continue.";
    return { message: `${state.error} ${next}`, error: true, active: false };
  }
  if (state.link === "connecting") return { message: "Waiting for the browser device picker…", error: false, active: true };
  if (state.link === "connected") {
    const message = state.notice ?? (state.transport?.simulated
      ? "Simulated preview — no hardware connected."
      : state.transport?.writable
        ? "Connected over USB-UART. One serial owner at a time; disconnect before flashing."
        : "Connected over Bluetooth (read-only). Use USB to configure Wi-Fi.");
    return { message, error: false, active: true };
  }
  return {
    message: state.notice ?? "Select an ESPForge board over USB or Bluetooth", error: false, active: false,
  };
}
