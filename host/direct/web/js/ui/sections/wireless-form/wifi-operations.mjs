// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { BoardError, REASON } from "../../../state/errors.mjs";
import { describe } from "../../messages.mjs";
import { queryElement } from "../../dom.mjs";
import { formTransition } from "./wireless-form-state.mjs";

/**
 * @typedef {object} WifiOperationsOptions
 * @property {() => ReturnType<typeof formTransition>} form
 * @property {(event: Parameters<typeof formTransition>[1]) => void} dispatch
 * @property {() => import("./wireless-form.mjs").WirelessStatus | null} status
 * @property {() => AbortSignal} signal
 * @property {import("./wireless-form.mjs").WirelessFormOptions["scan"]} scan
 * @property {import("./wireless-form.mjs").WirelessFormOptions["test"]} test
 * @property {import("./wireless-form.mjs").WirelessFormOptions["cancelTest"]} cancelTest
 * @property {() => boolean} ready
 * @property {() => number} now
 * @property {ReturnType<typeof import("./wireless-form-timers.mjs").createWirelessFormTimers>} timers
 * @property {(id: string, message: string | null | undefined) => void} setStatus
 * @property {() => void} refresh
 * @property {() => void} notify
 * @property {() => void} enableWifi
 *
 * @typedef {{clearInputs: () => void, clearStage: () => void, discard: () => Promise<boolean>,
 *   open: () => void, close: () => void}} WifiOperations
 */

/**
 * @brief Own Wi-Fi scan, test, cancellation and staging interactions for the provisioning form.
 * @param {WifiOperationsOptions} options
 * @return {WifiOperations}
 */
export function bindWifiOperations({
  form, dispatch, status, signal, scan, test, cancelTest, ready, now, timers, setStatus, refresh, notify,
  enableWifi,
}) {
  /** @param {string} id */
  const el = id => queryElement(`#${id}`);
  /** @param {string} id */
  const input = id => queryElement(`input#${id}`);
  /** @type {HTMLDialogElement} */
  const dialog = queryElement("dialog#direct-wifi-dialog");
  const clearInputs = () => { input("direct-wifi-password").value = ""; };
  const clearStage = () => {
    timers.clearStaged();
    dispatch({ type: "clearWifiStage" });
    input("direct-wifi-ssid").value = "";
    clearInputs();
  };
  /** @param {Awaited<ReturnType<WifiOperationsOptions["scan"]>>} networks */
  const renderNetworks = networks => {
    const list = el("direct-wifi-networks");
    list.replaceChildren();
    networks.forEach(network => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wifi-network";
      button.dataset.ssidHex = network.ssid_hex;
      const name = document.createElement("span");
      name.textContent = network.ssid;
      const details = document.createElement("small");
      details.textContent = `${network.security ?? (network.secured ? "Secured" : "Open")} · ${network.rssi} dBm`;
      button.append(name, details);
      button.addEventListener("click", () => {
        input("direct-wifi-ssid").value = network.ssid;
        dispatch({ type: "selectNetwork", ssidHex: network.ssid_hex });
        el("direct-wifi-manual-label").hidden = true;
        el("direct-wifi-password-label").hidden = !network.secured;
        clearInputs();
        refresh();
      });
      list.append(button);
    });
  };
  const discard = async () => {
    const current = form();
    if (current.phase === "canceling" || current.cancelNeedsReconnect) return false;
    if (current.wifiTestAttempted) {
      const activeSignal = signal();
      dispatch({ type: "cancel" });
      notify();
      try {
        await cancelTest(activeSignal);
      } catch (error) {
        if (activeSignal.aborted) return false;
        dispatch({ type: "cancelFailed", error: describe(error), needsReconnect: !ready() });
        setStatus("direct-wifi-status", `Could not clear the temporary Wi-Fi test: ${describe(error)}`);
        notify();
        return false;
      }
      if (activeSignal.aborted) return false;
    }
    dispatch({ type: "cleared" });
    clearStage();
    notify();
    return true;
  };
  const open = () => {
    const current = form();
    const latest = status();
    input("direct-wifi-ssid").value = current.wifiStage?.ssid ?? latest?.ssid ?? "";
    dispatch({ type: "loadSsid", ssidHex: current.wifiStage?.ssid_hex ?? latest?.ssid_hex });
    el("direct-wifi-password-label").hidden = false;
    el("direct-wifi-manual-label").hidden = false;
    if (current.phase !== "cancelFailed") {
      setStatus("direct-wifi-status", "Choose a network and test the connection. "
        + "Save requires a successful, unexpired test; Cancel clears temporary credentials.");
    }
    dialog.showModal();
  };
  const close = () => { if (dialog.open) dialog.close(); };

  el("direct-wifi-scan").addEventListener("click", async () => {
    const activeSignal = signal();
    dispatch({ type: "scan" });
    setStatus("direct-wifi-status", "Scanning for nearby networks…");
    notify();
    try {
      const networks = await scan(activeSignal);
      if (activeSignal.aborted) return;
      renderNetworks(networks);
      setStatus("direct-wifi-status", networks.length ? `Found ${networks.length} networks.` : "No networks found.");
    } catch (error) {
      if (!activeSignal.aborted) setStatus("direct-wifi-status", describe(error));
    } finally {
      if (!activeSignal.aborted) {
        dispatch({ type: "done" });
        notify();
      }
    }
  });
  el("direct-wifi-other").addEventListener("click", () => {
    dispatch({ type: "manualSsid" });
    input("direct-wifi-ssid").value = "";
    el("direct-wifi-manual-label").hidden = false;
    el("direct-wifi-password-label").hidden = false;
    refresh();
    input("direct-wifi-ssid").focus();
  });
  input("direct-wifi-ssid").addEventListener("input", () => {
    dispatch({ type: "editSsid" });
    refresh();
  });
  input("direct-wifi-password").addEventListener("input", refresh);
  el("direct-wifi-connect").addEventListener("click", async () => {
    const current = form();
    const ssid = input("direct-wifi-ssid").value;
    const password = input("direct-wifi-password").value;
    if (!ssid) return;
    const activeSignal = signal();
    const started = now();
    dispatch({ type: "testStarted" });
    timers.clearStaged();
    let succeeded = false;
    let step = "Starting";
    const progress = () => {
      const elapsed = Math.floor((now() - started) / 1000);
      setStatus("direct-wifi-status", elapsed < 30
        ? `Testing “${ssid}”: ${step}… ${elapsed}s (up to 30s).`
        : `Testing “${ssid}”: ${step}… ${elapsed}s; waiting for the final result.`);
    };
    progress();
    timers.startTest(progress);
    notify();
    try {
      const rawSsid = current.selectedSsidHex === undefined ? {} : { ssid_hex: current.selectedSsidHex };
      const result = await test({ ssid, password, ...rawSsid }, next => {
        if (activeSignal.aborted || !next || next === step) return;
        step = describe(next);
        progress();
      }, activeSignal);
      if (activeSignal.aborted) return;
      if (!Number.isInteger(result.remaining_seconds) || result.remaining_seconds < 1
          || result.remaining_seconds > 600) throw new BoardError(REASON.LIFETIME_INVALID);
      dispatch({ type: "testSucceeded", pair: { ssid, ...rawSsid, use_tested_wifi: true, tested_at: now(),
        remaining_seconds: result.remaining_seconds } });
      timers.startStaged();
      enableWifi();
      clearInputs();
      setStatus("direct-wifi-status",
        `Connected to “${ssid}” (${result.ipv4 || "IP assigned"}). Click Save&Reboot.`);
      succeeded = true;
    } catch (error) {
      if (!activeSignal.aborted) setStatus("direct-wifi-status", describe(error));
    } finally {
      if (!activeSignal.aborted) {
        timers.stopTest();
        dispatch({ type: "done" });
        notify();
        if (succeeded) dialog.close();
      }
    }
  });
  el("direct-wifi-cancel").addEventListener("click", async () => {
    const current = form();
    if (current.phase === "scanning" || current.phase === "testing") return;
    const activeSignal = signal();
    if (await discard() && !activeSignal.aborted) dialog.close();
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    const current = form();
    if (current.phase === "scanning" || current.phase === "testing") return;
    const activeSignal = signal();
    void discard().then(cleared => { if (cleared && !activeSignal.aborted) dialog.close(); });
  });
  return { clearInputs, clearStage, discard, open, close };
}
