// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { OP } from "../../../protocol/constants.mjs";
import { createTimerScope } from "../../../timers.mjs";
import { queryElement, setText } from "../../dom.mjs";
import { bindBleKeyForm } from "./ble-key-form.mjs";
import { renderWirelessForm } from "./wireless-form-view.mjs";
import { formTransition, IDLE_FORM } from "./wireless-form-state.mjs";
import { createWirelessFormTimers } from "./wireless-form-timers.mjs";
import { bindWifiOperations } from "./wifi-operations.mjs";

/**
 * @typedef {Partial<ReturnType<typeof import("../../../protocol/codec.mjs").decodeWireless>>} WirelessStatus
 * @typedef {ReturnType<typeof formTransition>} FormState
 * @typedef {import("./wireless-form-state.mjs").TestedPair} TestedPair
 * @typedef {{wireless: boolean, settings: boolean}} FormReadiness
 * @typedef {object} WirelessFormOptions
 * @property {(signal: AbortSignal)
 *   => Promise<ReturnType<typeof import("../../../protocol/codec.mjs").decodeScanEntry>[]>} scan
 * @property {(settings: import("../../../board/operations.mjs").WirelessPair,
 *   onProgress: (progress: import("../../../state/reducer.mjs").ReasonValue) => void,
 *   signal: AbortSignal) => Promise<{remaining_seconds: number, ipv4?: string}>} test
 * @property {(signal: AbortSignal) => Promise<void>} cancelTest
 * @property {() => boolean} ready
 * @property {() => boolean} [settingsReady]
 * @property {() => boolean} supported
 * @property {() => void} [changed]
 * @property {ReturnType<typeof createTimerScope>} [timerScope]
 * @property {() => number} [now]
 * @property {Pick<Clipboard, "writeText"> | null} [clipboard]
 *
 * @typedef {object} WirelessForm
 * @property {AbortSignal} signal Draft lifecycle, aborted on reset.
 * @property {() => boolean} dirty
 * @property {() => boolean} operationBusy
 * @property {() => boolean} canSave
 * @property {() => string | null} saveBlockReason
 * @property {() => import("../../../board/operations.mjs").WirelessConfiguration | null} request
 * @property {(saved: WirelessStatus | null, error?: string) => void} finish
 * @property {() => void} reset
 * @property {() => void} dispose
 * @property {(state?: import("../../../state/reducer.mjs").DashboardState, readiness?: FormReadiness) => void} update
 */

/**
 * @brief Bind the Wi-Fi/Bluetooth provisioning dialogs. Status comes from the session-polled `state.wireless`
 * passed to `update`; this controller owns Wi-Fi operations, the shared lifecycle and configuration composition.
 * Key drafts and DOM availability/summary rendering are delegated to their respective modules.
 * Device I/O runs only through the injected scan/test/cancelTest intents.
 * @param {WirelessFormOptions} options
 * @return {WirelessForm}
 */
export function bindWirelessForm({
  scan, test, cancelTest, ready, settingsReady = ready, supported, changed = () => {}, timerScope,
  now = () => Date.now(), clipboard = null,
}) {
  const timers = timerScope?.createChild() ?? createTimerScope();
  /** @param {string} id */
  const el = id => queryElement(`#${id}`);
  /** @param {string} id */
  const input = id => queryElement(`input#${id}`);
  /** @param {string} id */
  const select = id => queryElement(`select#${id}`);
  let loaded = false;
  let lifecycleController = new AbortController();
  /** @type {WirelessStatus | null} */
  let status = null;
  /** @type {ReturnType<typeof formTransition>} */
  let form = { ...IDLE_FORM };
  /** @param {Parameters<typeof formTransition>[1]} event */
  const dispatch = event => { form = formTransition(form, event); };

  /** @param {string} id @param {string | null | undefined} message */
  const setStatus = (id, message) => setText({ [id]: message });
  /** @param {string} id */
  const radioOn = id => select(id).value === "1";
  const remainingTestSeconds = () => form.wifiStage
    ? Math.max(0, form.wifiStage.remaining_seconds - Math.floor((now() - form.wifiStage.tested_at) / 1000)) : 0;
  const testExpired = () => Boolean(radioOn("direct-settings-wifi") && form.wifiStage?.use_tested_wifi
    && remainingTestSeconds() === 0);
  const working = () => form.phase === "scanning" || form.phase === "testing";
  const clearing = () => form.phase === "canceling" || form.phase === "cancelFailed";
  const saveBlockReason = () => working() ? "Finish the wireless operation before saving."
    : clearing() ? "Clear the temporary Wi-Fi test before saving."
      : form.wifiTestAttempted && !form.wifiStage
        ? "Test the connection again or clear the temporary Wi-Fi test before saving."
        : testExpired() ? "Test credentials expired; test the connection again before saving."
          : bleKey.saveBlockReason();
  /** @param {FormReadiness} [readiness] Same-snapshot gates during dashboard rendering only. */
  const refresh = readiness => {
    const available = supported();
    const wirelessReady = readiness?.wireless ?? ready();
    renderWirelessForm({ available, wirelessReady, radioReady: readiness?.settings ?? settingsReady(),
      status, form, wifiStage: form.wifiStage, remainingSeconds: remainingTestSeconds(),
      selectedSsidHex: form.selectedSsidHex, keyDirty: bleKey.dirty(),
      saveBlockReason: saveBlockReason() });
  };
  const notify = () => { refresh(); changed(); };
  const formTimers = createWirelessFormTimers({
    timers,
    onStageTick: () => refresh(),
    isExpired: () => testExpired(),
    onExpired: () => changed(),
  });
  /** Disabling a saved-enabled radio erases its credentials at the next save. */
  const erasing = () => Boolean(supported() && status && (
    !radioOn("direct-settings-wifi") && status.wifi_enabled && status.ssid
    || !radioOn("direct-settings-ble") && status.ble_enabled && status.ble_key_configured));
  const dirty = () => Boolean(form.wifiTestAttempted || bleKey.dirty() || erasing());
  /** @param {"direct-settings-wifi" | "direct-settings-ble"} id */
  const enableRadio = id => {
    if (radioOn(id)) return;
    select(id).value = "1";
    select(id).dispatchEvent(new Event("change"));
  };
  const bleKey = bindBleKeyForm({
    signal: () => lifecycleController.signal, configured: () => Boolean(status?.ble_key_configured),
    enable: () => enableRadio("direct-settings-ble"), changed: notify, clipboard,
  });
  const wifi = bindWifiOperations({
    form: () => form, dispatch, status: () => status, signal: () => lifecycleController.signal,
    scan, test, cancelTest, ready, now, timers: formTimers, setStatus, refresh, notify,
    enableWifi: () => enableRadio("direct-settings-wifi"),
  });
  // "input" fires before "change", so the dashboards' change handlers only ever see Enabled or Disabled.
  for (const [id, open] of /** @type {[string, () => void][]} */ ([["direct-settings-wifi", wifi.open],
    ["direct-settings-ble", bleKey.open]])) {
    let previous = select(id).value;
    select(id).addEventListener("focus", () => { previous = select(id).value; });
    el(id).addEventListener("input", () => {
      if (select(id).value === "configure") {
        select(id).value = previous;
        open();
      } else if (previous === "1" && select(id).value === "0" && id === "direct-settings-wifi"
          && form.wifiTestAttempted) {
        const signal = lifecycleController.signal;
        void wifi.discard().then(cleared => {
          if (signal.aborted) return;
          if (cleared) {
            previous = "0";
            changed();
          } else {
            select(id).value = "1";
            previous = "1";
            wifi.open();
            notify();
          }
        });
      } else {
        previous = select(id).value;
        if (previous === "0" && id === "direct-settings-ble") bleKey.clear();
      }
      refresh();
    });
  }
  return {
    /** @brief Draft lifecycle; reset aborts it so old save completions cannot change a new draft. */
    get signal() { return lifecycleController.signal; },
    dirty,
    operationBusy: () => form.phase !== "idle",
    saveBlockReason,
    canSave: () => saveBlockReason() === null,
    /** @return {import("../../../board/operations.mjs").WirelessConfiguration | null} */
    request() {
      const blocked = saveBlockReason();
      if (blocked) throw new Error(blocked);
      if (!dirty()) return null;
      const wifi = radioOn("direct-settings-wifi");
      const ble = radioOn("direct-settings-ble");
      /** @type {import("../../../board/operations.mjs").WirelessConfiguration} */
      const config = { wifi_enabled: wifi, ble_enabled: ble,
        ssid: wifi ? form.wifiStage?.ssid ?? status?.ssid ?? "" : "" };
      const rawSsid = wifi ? form.wifiStage ? form.wifiStage.ssid_hex : status?.ssid_hex : undefined;
      if (rawSsid !== undefined) config.ssid_hex = rawSsid;
      if (wifi && form.wifiStage?.use_tested_wifi) config.use_tested_wifi = true;
      if (!wifi && status?.ssid) config.password = "";
      const key = bleKey.request(ble);
      if (key !== undefined) config.ble_key = key;
      return config;
    },
    /** @param {WirelessStatus | null} saved @param {string} [error] */
    finish(saved, error) {
      wifi.clearInputs();
      bleKey.finish(Boolean(saved), error);
      if (saved) {
        status = { ...status, ...saved };
        wifi.clearStage();
        loaded = true;
        setStatus("direct-wifi-status", "Wireless settings saved.");
      } else {
        setStatus("direct-wifi-status", error);
      }
      notify();
    },
    reset() {
      lifecycleController.abort(new DOMException("Wireless form reset", "AbortError"));
      lifecycleController = new AbortController();
      formTimers.clear();
      dispatch({ type: "reset" });
      status = null;
      loaded = false;
      wifi.clearStage();
      bleKey.reset();
      el("direct-wifi-networks").replaceChildren();
      wifi.close();
    },
    dispose() {
      this.reset();
      timers.dispose();
    },
    /**
     * @brief Adopt the first polled wireless snapshot after (re)connect and apply recovery outcomes.
     * @param {import("../../../state/reducer.mjs").DashboardState} [state]
     * @param {FormReadiness} [readiness]
     */
    update(state, readiness) {
      let recoveredCancellation = false;
      if (form.phase === "cancelFailed" && state?.connected && !state.outcome_uncertain) {
        dispatch({ type: "recovered" });
        if (state.recovered_opcode === OP.CANCEL_TEST) {
          wifi.clearStage();
          dispatch({ type: "reset" });
          setStatus("direct-wifi-status", "Temporary Wi-Fi test cleared after reconnect.");
          recoveredCancellation = true;
        }
      }
      if (!loaded && state?.wireless && supported()) {
        status = state.wireless;
        loaded = true;
        if (!form.wifiStage && !form.wifiEdited) input("direct-wifi-ssid").value = status.ssid;
      }
      refresh(readiness);
      if (recoveredCancellation) changed();
    },
  };
}
