// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file Pure wireless form operation-state transitions.
 */

/**
 * @typedef {{ssid: string, ssid_hex?: string, use_tested_wifi: true, tested_at: number,
 *   remaining_seconds: number}} TestedPair
 * @typedef {{phase: "idle" | "scanning" | "testing" | "canceling" | "cancelFailed",
 *   cancelError: string | null, cancelNeedsReconnect: boolean, wifiStage: TestedPair | null,
 *   wifiTestAttempted: boolean, wifiEdited: boolean, selectedSsidHex?: string}} FormState
 * @typedef {{type: "scan" | "test" | "testStarted" | "done" | "cancel" | "cancelFailed" | "cleared"
 *   | "clearWifiStage" | "recovered" | "reset" | "loadSsid" | "selectNetwork" | "editSsid" | "manualSsid"
 *   | "testSucceeded", error?: string, needsReconnect?: boolean, ssidHex?: string, pair?: TestedPair}} FormEvent
 */

/** @type {Readonly<FormState>} */
export const IDLE_FORM = Object.freeze({
  phase: "idle", cancelError: null, cancelNeedsReconnect: false, wifiStage: null, wifiTestAttempted: false,
  wifiEdited: false, selectedSsidHex: undefined,
});

/**
 * @brief Pure form-operation state machine; out-of-phase events leave state unchanged.
 * @param {FormState} form
 * @param {FormEvent} event
 * @return {FormState}
 */
export function formTransition(form, event) {
  const idle = { ...IDLE_FORM };
  switch (event.type) {
    case "scan": case "test": return form.phase === "idle" ? { ...form, phase: event.type === "scan"
      ? "scanning" : "testing" } : form;
    case "testStarted": return form.phase === "idle" ? { ...form, phase: "testing", wifiStage: null,
      wifiTestAttempted: true } : form;
    case "loadSsid": return { ...form, selectedSsidHex: event.ssidHex };
    case "selectNetwork": return { ...form, selectedSsidHex: event.ssidHex, wifiEdited: true };
    case "editSsid": return { ...form, selectedSsidHex: undefined, wifiEdited: true };
    case "manualSsid": return { ...form, selectedSsidHex: undefined };
    case "testSucceeded": return event.pair ? { ...form, wifiStage: event.pair, wifiEdited: false } : form;
    case "clearWifiStage": return { ...form, wifiStage: null, wifiTestAttempted: false, wifiEdited: false,
      selectedSsidHex: undefined };
    case "done": return form.phase === "scanning" ? { ...form, phase: "idle" }
      : form.phase === "testing" ? { ...form, phase: "idle" } : form;
    case "cancel": return ["idle", "cancelFailed"].includes(form.phase) && !form.cancelNeedsReconnect
      ? { ...form, phase: "canceling" } : form;
    case "cancelFailed": return form.phase === "canceling" ? { ...form, phase: "cancelFailed", cancelError: event.error ?? null,
      cancelNeedsReconnect: Boolean(event.needsReconnect) } : form;
    case "cleared": return form.phase === "canceling" || form.phase === "idle" ? idle : form;
    case "recovered": return form.phase === "cancelFailed" ? { ...form, cancelNeedsReconnect: false } : form;
    case "reset": return idle;
    default: return form;
  }
}
