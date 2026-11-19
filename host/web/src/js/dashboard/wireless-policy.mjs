// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/**
 * @typedef {"wifi" | "ble"} Radio
 * @typedef {"preserve" | "replace" | "erase"} CredentialAction
 * @typedef {{ssid: string, ssid_hex?: string}} WifiPair
 * @typedef {WifiPair & {use_tested_wifi: true, tested_at: number, remaining_seconds: number,
 * test_generation: number, test_id: string}} TestedPair
 * @typedef {WifiPair & {wifi_enabled?: boolean, ble_enabled?: boolean, ble_key_configured?: boolean,
 * tcp_cli_enabled?: boolean, stale?: boolean, key_staged?: boolean,
 * ssid_staged?: boolean, password_staged?: boolean, pair_tested?: boolean,
 * test_generation?: number}} WirelessConfiguration
 * @typedef {{wifi_enabled: boolean, ble_enabled: boolean, confirm_reboot: true,
 * ssid?: string, ssid_hex?: string, password?: string, ble_key?: string,
 * use_tested_wifi?: true, test_id?: string, test_generation?: number}} WirelessSave
 * @typedef {{
 * status: WirelessConfiguration | null,
 * draft: Partial<Record<Radio, boolean>>,
 * ssid: string,
 * password: string,
 * bleKey: string,
 * configurationConflict: boolean,
 * foreignStage: boolean,
 * awaitingPair: boolean,
 * wifiStage: TestedPair | null,
 * wifiAttempt: WifiPair | null,
 * selectedSsidHex: string | null,
 * wifiEdited: boolean,
 * keyDirty: boolean,
 * keyNeedsRegeneration: boolean,
 * keyRevision: number,
 * busy: boolean,
 * wifiCanceling: boolean,
 * wifiCancelError: string | null,
 * cleanupRequired: boolean,
 * remainingTestSeconds: number,
 * }} WirelessPolicyState
 */

/** @param {string} ssid */
export function wirelessSsidBytes(ssid) {
  return [...new TextEncoder().encode(ssid)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {WifiPair} wireless */
export function wirelessPairBytes(wireless) {
  return wireless.ssid_hex?.toLowerCase() ?? wirelessSsidBytes(wireless.ssid);
}

/** @param {Partial<Record<Radio, boolean>>} draft @param {WirelessConfiguration | null} status
 * @param {Radio} radio @param {boolean} value
 */
export function editWirelessRadio(draft, status, radio, value) {
  const saved = radio === "wifi" ? status?.wifi_enabled : status?.ble_enabled;
  const next = { ...draft };
  if (value === saved) delete next[radio];
  else next[radio] = value;
  return next;
}

/** @param {WirelessPolicyState} state @param {Radio} radio */
export function wirelessRadioOn(state, radio) {
  return state.draft[radio] ?? (radio === "wifi" ? state.status?.wifi_enabled : state.status?.ble_enabled) ?? false;
}

/** @param {WirelessPolicyState} state @param {Radio} radio */
export function wirelessRadioEdited(state, radio) {
  return state.draft[radio] !== undefined;
}

/** @param {WirelessPolicyState} state @returns {{wifi: CredentialAction, ble: CredentialAction}} */
export function wirelessCredentialActions(state) {
  return {
    wifi: wirelessRadioEdited(state, "wifi") && !wirelessRadioOn(state, "wifi") && state.status?.ssid
      ? "erase"
      : wirelessRadioOn(state, "wifi") && state.wifiStage ? "replace" : "preserve",
    ble: wirelessRadioEdited(state, "ble") && !wirelessRadioOn(state, "ble") && state.status?.ble_key_configured
      ? "erase"
      : wirelessRadioOn(state, "ble") && state.keyDirty ? "replace" : "preserve",
  };
}

/** @param {WirelessPolicyState} state */
export function wirelessDirty(state) {
  return Boolean(state.wifiAttempt || state.keyDirty
    || Object.values(wirelessCredentialActions(state)).includes("erase")
    || (wirelessRadioEdited(state, "wifi") || wirelessRadioEdited(state, "ble")) && !state.status);
}

/** @param {WirelessPolicyState} state */
export function wirelessTestExpired(state) {
  return Boolean(wirelessRadioOn(state, "wifi") && state.wifiStage?.use_tested_wifi
    && state.remainingTestSeconds === 0);
}

/** @param {WirelessPolicyState} state */
export function wirelessSaveBlockReason(state) {
  const wifiEdited = wirelessRadioEdited(state, "wifi");
  const bleEdited = wirelessRadioEdited(state, "ble");
  const wifiOn = wirelessRadioOn(state, "wifi");
  const bleOn = wirelessRadioOn(state, "ble");
  if (state.configurationConflict)
    return "Wireless configuration changed on the board. Discard wireless edits and reload its configuration "
      + "before saving.";
  if ((wifiEdited || bleEdited) && !state.status)
    return "Waiting for fresh wireless configuration before saving radio changes.";
  if (state.foreignStage)
    return "Clear the temporary wireless credentials in Wi-Fi settings before saving; another client staged them.";
  if (state.awaitingPair)
    return "Waiting for status matching the tested pair. If it was replaced, test again or clear the test.";
  if (state.busy) return "Finish the wireless operation before saving.";
  if (state.wifiCanceling || state.wifiCancelError || state.cleanupRequired)
    return "Clear the temporary Wi-Fi test before saving.";
  if (state.wifiAttempt && !state.wifiStage)
    return "Test the connection again or clear the temporary Wi-Fi test before saving.";
  if (wifiOn && state.wifiEdited) return "Network details changed; test the connection again before saving.";
  if (wirelessTestExpired(state)) return "Test credentials expired; test the connection again before saving.";
  if (state.keyNeedsRegeneration) return "Generate a replacement Control key or disable Bluetooth before saving.";
  if (wifiEdited && wifiOn && !state.status?.ssid && !state.wifiStage) return "Test a network before enabling Wi-Fi.";
  if (bleEdited && bleOn && !state.status?.ble_key_configured && !state.keyDirty)
    return "Generate a Control key before enabling Bluetooth.";
  return null;
}

/** @param {WirelessPolicyState} state @param {number} saved */
export function wirelessSelectedRadios(state, saved) {
  return (state.draft.wifi === undefined ? saved & 1 : Number(state.draft.wifi))
    | (state.draft.ble === undefined ? saved & 2 : Number(state.draft.ble) << 1);
}

/** @param {WirelessPolicyState} state */
export function wirelessSaveIdentity(state) {
  return JSON.stringify([
    wirelessCredentialActions(state), state.keyRevision,
    state.wifiStage?.test_id ?? null, state.wifiStage?.test_generation ?? null,
    state.wifiStage ? wirelessPairBytes(state.wifiStage) : null, wirelessDirty(state),
  ]);
}

/** @param {WirelessPolicyState} state */
export function wirelessSaveRequest(state) {
  const wifi = wirelessRadioOn(state, "wifi");
  const ble = wirelessRadioOn(state, "ble");
  /** @type {WirelessSave} */
  const config = { wifi_enabled: wifi, ble_enabled: ble, confirm_reboot: true };
  if (wifi && state.wifiStage?.use_tested_wifi) {
    config.ssid = state.wifiStage.ssid;
    if (state.wifiStage.ssid_hex !== undefined) config.ssid_hex = state.wifiStage.ssid_hex;
    config.use_tested_wifi = true;
    config.test_generation = state.wifiStage.test_generation;
    config.test_id = state.wifiStage.test_id;
  }
  const credentials = wirelessCredentialActions(state);
  if (credentials.wifi === "erase") { config.ssid = ""; config.password = ""; }
  if (ble && state.keyDirty) config.ble_key = state.bleKey;
  else if (credentials.ble === "erase") config.ble_key = "";
  return config;
}
