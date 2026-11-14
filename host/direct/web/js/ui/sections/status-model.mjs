// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { deriveOperationEligibility } from "../../state/selectors.mjs";

/**
 * @typedef {Omit<import("../../state/reducer.mjs").DashboardState,
 *   "error" | "recovery_message" | "wireless_error" | "wireless_poll_error"> & {
 *   error?: string | null, recovery_message?: string | null, wireless_error?: string | null,
 *   wireless_poll_error?: string | null}} DashboardPresentation
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
  return {
    eligibility: deriveViewEligibility(state, formBusy),
    connection_state: state.error ? "error" : connected ? "connected" : "disconnected",
    connection_label: state.error ? "Attention" : state.reconnecting ? "Reconnecting"
      : connected ? "Connected" : "Disconnected",
    status_message: state.error ?? (state.reconnecting ? "USB device reconnecting; reopening HID automatically"
      : state.recovery_message ?? (state.reboot_pending ? "Reboot accepted; waiting for USB reconnection"
        : state.runtime ? "HID status is live"
          : connected ? "Waiting for first status report" : "Select an ESPForge device")),
  };
}
