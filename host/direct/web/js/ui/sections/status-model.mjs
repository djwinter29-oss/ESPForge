// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/** @file Pure presentation model: connection banner text and form-aware operation eligibility. */
import { deriveOperationEligibility } from "../../state/selectors.mjs";

/**
 * @typedef {Omit<import("../../state/reducer.mjs").DashboardState,
 *   "error" | "recovery_message" | "wireless_error" | "wireless_poll_error"> & {
 *   error?: string | null, recovery_message?: string | null, wireless_error?: string | null,
 *   wireless_poll_error?: string | null, action_error?: string | null}} DashboardPresentation
 */

/** @brief Readiness with the dashboard-only wireless-form lock folded in: a running form operation blocks writes. */
export function deriveViewEligibility(state, formBusy = false) {
  const eligibility = deriveOperationEligibility(state);
  return formBusy ? { ...eligibility, blocked: true, settingsReady: false, wirelessReady: false, mscReady: false,
    benchmarkReady: false, benchmarkCancelReady: false, ledReady: false }
    : eligibility;
}

/**
 * @brief Derive display values from a snapshot without reading or mutating the DOM.
 * @param {DashboardPresentation} state
 * @param {boolean} [formBusy]
 */
export function deriveDashboardViewModel(state, formBusy = false) {
  const connected = Boolean(state.connected);
  const bluetooth = state.link === "ble";
  const rebooting = bluetooth ? "Reboot accepted; reconnect Bluetooth after the board restarts"
    : "Reboot accepted; waiting for USB reconnection";
  const reconnecting = bluetooth ? "Bluetooth device reconnecting; reopening automatically"
    : "USB device reconnecting; reopening HID automatically";
  const connectionError = Boolean(state.error && !connected && !state.reconnecting);
  return {
    eligibility: deriveViewEligibility(state, formBusy),
    connection_state: state.reconnecting ? "reconnecting" : connected ? "connected"
      : connectionError ? "error" : "disconnected",
    connection_label: state.reconnecting ? "Reconnecting" : connected ? "Connected"
      : connectionError ? "Attention" : "Disconnected",
    status_message: state.error ?? state.action_error ?? (state.reconnecting ? reconnecting
      : state.recovery_message ?? (state.reboot_pending ? rebooting
        : state.runtime ? `${bluetooth ? "Bluetooth" : "USB"} status is live`
          : connected ? "Waiting for first status report" : "Select an ESPForge device")),
    status_error: Boolean(state.error || state.action_error),
  };
}
