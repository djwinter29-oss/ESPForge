// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { CAP, STAGED_EXPIRED } from "../protocol/constants.mjs";
import { createDashboardView, renderControls } from "./dashboard-view.mjs";
import { bindWirelessForm } from "./sections/wireless-form.mjs";
import { canRun } from "../state/selectors.mjs";
import { createUiStore, UI_INITIAL } from "../state/store.mjs";
import { parseHexBytes } from "../protocol/codec.mjs";
import { queryElement } from "./dom.mjs";
import { deriveDashboardViewModel } from "./sections/status-model.mjs";
import { describe } from "./messages.mjs";

/**
 * @typedef {{secure: boolean, hid: boolean, ble: boolean, now: () => number,
 *   clipboard: Pick<Clipboard, "writeText"> | null}} DashboardEnvironment
 * @typedef {{session: import("../board/session.mjs").BoardSession,
 *   selectTransport: (kind: "usb" | "ble") => import("../board/session.mjs").BoardSession,
 *   timers: ReturnType<typeof import("../timers.mjs").createTimerScope>,
 *   environment: DashboardEnvironment}} DashboardOptions
 */

/**
 * @brief Wire the dashboard DOM to a board session: subscribe to its domain store, send user intents to it, render.
 * @param {DashboardOptions} options Injected session, timers, intents and browser facts.
 */
export function mountDashboard({ session, selectTransport, timers, environment }) {
  /** @param {string} id */
  const element = id => queryElement(`#${id}`);
  /** @param {string} id */
  const button = id => queryElement(`button#${id}`);
  let client = session;
  let disposed = false;
  const ui = createUiStore();
  /** @param {Partial<import("../state/reducer.mjs").UiState>} changes */
  const setUi = changes => ui.dispatch({ type: "patch", changes });
  const renderStatus = createDashboardView();
  const usbDialog = queryElement("dialog#usb-connection-dialog");
  const bluetoothDialog = queryElement("dialog#bluetooth-connection-dialog");
  const settingsSave = button("settings-save");
  const settingsReboot = button("settings-reboot");
  const settingsClock = queryElement("select#settings-clock");
  const settingsRadios = [queryElement("select#direct-settings-wifi"), queryElement("select#direct-settings-ble")];
  const controlKey = queryElement("input#direct-ble-control-key");
  const selectedRadios = () => client.state.hardware?.capabilities & CAP.WIRELESS
    ? Number(settingsRadios[0].value) | Number(settingsRadios[1].value) << 1 : 0;
  const configurationDialog = queryElement("dialog#configuration-dialog");
  const rebootDialog = queryElement("dialog#reboot-dialog");
  const mscDialog = queryElement("dialog#msc-dialog");
  let mscTarget = false;
  let mscUid = null;
  let wasConnected = client.state.connected;
  let refreshQueued = false;
  /** Coalesce bursts of client state changes into one render and side-effect pass per microtask. */
  const scheduleRefresh = () => {
    if (refreshQueued || disposed) return;
    refreshQueued = true;
    queueMicrotask(refresh);
  };
  const bluetoothLink = () => client.state.link === "ble";
  /** @type {ReturnType<typeof bindWirelessForm>} */
  let wirelessForm;
  wirelessForm = bindWirelessForm({
    supported: () => Boolean(client.state.hardware?.capabilities & CAP.WIRELESS),
    settingsReady: () => !bluetoothLink() && canRun(client.state, "settings").allowed,
    timerScope: timers,
    now: environment.now,
    clipboard: environment.clipboard,
    ready: () => canRun(client.state, "wireless").allowed,
    scan: signal => client.scanWireless(signal),
    test: (settings, onProgress, signal) => client.testWireless(settings, onProgress, signal),
    cancelTest: signal => client.cancelWireless(signal),
    changed: () => setUi({ wireless_form_busy: wirelessForm.operationBusy() }),
  });
  ui.subscribe(scheduleRefresh);
  let watched = null;
  let unwatch = () => {};
  /** Follow the session's domain store; a transport switch may hand over a session with a different store. */
  const watch = () => {
    if (watched === client.store) return;
    unwatch();
    watched = client.store;
    unwatch = watched.subscribe(scheduleRefresh);
  };
  watch();
  /** Reset dashboard-only state after a disconnect, then render once. Performs no device I/O. */
  function refresh() {
    refreshQueued = false;
    if (disposed) return;
    const board = client.state;
    if (wasConnected && !board.connected) {
      wirelessForm.reset();
      ui.dispatch({ type: "replace", state: { ...UI_INITIAL, action_error: ui.getState().action_error } });
      for (const dialog of [configurationDialog, rebootDialog, mscDialog]) dialog.close();
    }
    wasConnected = board.connected;
    render(board, ui.getState());
  }

  /** View update: reads board and UI state, writes only DOM and the form's adopted snapshot. */
  /** @param {import("../state/reducer.mjs").DashboardState} board
   * @param {import("../state/reducer.mjs").UiState} view */
  function render(board, view) {
    // Domain state carries reason codes; this is the one place they become text.
    const state = { ...board, error: describe(board.error) ?? view.action_error,
      recovery_message: describe(board.recovery_message), wireless_error: describe(board.wireless_error),
      wireless_poll_error: describe(board.wireless_poll_error) };
    const viewModel = deriveDashboardViewModel(state, view.wireless_form_busy);
    const settingsReady = canRun(board, "settings", viewModel.eligibility).allowed;
    const wirelessReady = canRun(board, "wireless", viewModel.eligibility).allowed;
    renderStatus({ ...state, ...viewModel }, viewModel);
    renderControls(state, { eligibility: viewModel.eligibility, formBusy: view.wireless_form_busy,
      settingsMessage: view.settings_message, bleName: client.transport.name, settingsDirty: view.settings_dirty,
      wirelessDirty: wirelessForm.dirty(),
      wirelessSaveBlockReason: wirelessForm.saveBlockReason() }, environment);
    wirelessForm.update(board, { wireless: wirelessReady, settings: !bluetoothLink() && settingsReady });
  }

  async function run(operation) {
    setUi({ action_error: null });
    try { await operation(); } catch (error) { setUi({ action_error: describe(error) }); }
  }

  for (const [id, enabled] of /** @type {[string, boolean][]} */ (
    [["msc-enable", true], ["msc-return", false]])) {
    button(id).addEventListener("click", () => {
      if (button(id).disabled) return;
      mscTarget = enabled;
      mscUid = client.state.hardware?.serial_number;
      element("msc-dialog-title").textContent = enabled ? "Enable USB drive?" : "Return card to firmware?";
      element("msc-warning").textContent = enabled
        ? "Firmware will unmount the card and give Linux/Windows exclusive access. USB reconnects briefly; unsaved dashboard edits may be lost."
        : "Safely eject the USB drive in Linux/Windows first. Confirm only after eject completes; firmware cannot verify the host cache is flushed.";
      element("confirm-msc").textContent = enabled ? "Enable USB drive" : "I have safely ejected";
      mscDialog.showModal();
    });
  }
  element("cancel-msc").addEventListener("click", () => mscDialog.close());
  element("confirm-msc").addEventListener("click", () => run(async () => {
    if (!mscDialog.open) return;
    const enabled = mscTarget;
    mscDialog.close();
    if (!client.state.connected || bluetoothLink() || client.state.hardware?.serial_number !== mscUid) {
      setUi({ action_error: "Board changed; reopen the storage dialog." });
      return;
    }
    await client.setMsc(enabled, !enabled);
  }));

  for (const [id, dialog, bluetooth] of /** @type {[string, HTMLDialogElement, boolean][]} */ (
    [["usb-open", usbDialog, false], ["bluetooth-open", bluetoothDialog, true]])) {
    element(id).addEventListener("click", () => {
      if (button(id).disabled) return;
      if ((client.state.link === "ble") !== bluetooth) {
        client = selectTransport(bluetooth ? "ble" : "usb");
        watch();
      }
      scheduleRefresh();
      dialog.showModal();
    });
  }
  element("usb-connect").addEventListener("click", () => run(async () => {
    if (button("usb-connect").disabled) return;
    if (client.state.connected || client.state.reconnecting) await client.disconnect();
    else {
      await client.connect();
      if (client.state.connected) usbDialog.close();
    }
  }));
  element("bluetooth-scan").addEventListener("click", () => run(async () => {
    if (button("bluetooth-scan").disabled) return;
    if (client.state.connected || client.state.reconnecting) {
      await client.disconnect();
      return;
    }
    const key = controlKey.value;
    controlKey.value = "";
    await client.connect(parseHexBytes(key, 32, "control-key"));
    if (client.state.connected) bluetoothDialog.close();
  }));
  for (const [name, dialog] of /** @type {[string, HTMLDialogElement][]} */ (
    [["usb", usbDialog], ["bluetooth", bluetoothDialog]])) {
    element(`${name}-connection-close`).addEventListener("click", () => {
      if (!client.state.busy) dialog.close();
    });
    dialog.addEventListener("cancel", event => {
      if (client.state.busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => { controlKey.value = ""; });
  }
  for (const control of [settingsClock, ...settingsRadios]) {
    control.addEventListener("change", () => {
      setUi({ settings_dirty: Number(settingsClock.value) !== client.state.settings?.system_clock_mhz
        || selectedRadios() !== (client.state.settings?.radios ?? 0) });
      scheduleRefresh();
    });
  }
  settingsSave.addEventListener("click", () => {
    if (settingsSave.disabled) return;
    const bluetooth = bluetoothLink();
    const wirelessWarning = element("direct-configuration-wireless-warning");
    wirelessWarning.textContent = "Wi-Fi and Bluetooth credentials are saved with these settings. Keep a copy of "
      + "the Control key; it cannot be read back. Flash credentials are not encrypted.";
    wirelessWarning.hidden = bluetooth || !wirelessForm.dirty();
    const clock = Number(settingsClock.value);
    element("configuration-dialog-profile").textContent =
      `System clock: ${clock ? `${clock} MHz` : "Default"}.`
      + (!bluetooth && client.state.hardware?.capabilities & CAP.WIRELESS
        ? ` Wi-Fi: ${selectedRadios() & 1 ? "Enabled" : "Disabled"}.`
          + ` Bluetooth: ${selectedRadios() & 2 ? "Enabled" : "Disabled"}.` : "");
    configurationDialog.showModal();
  });
  element("confirm-configuration").addEventListener("click", () => run(async () => {
    if (!configurationDialog.open) return;
    configurationDialog.close();
    if (settingsSave.disabled) return;
    const owner = client;
    const signal = wirelessForm.signal;
    const generation = owner.connection.generation;
    const current = () => !disposed && client === owner && !signal.aborted
      && owner.connection.generation === generation;
    const bluetooth = bluetoothLink();
    // ESPForge has one SD-card profile; Bluetooth keeps the saved radio switches.
    const settings = { system_clock_mhz: Number(settingsClock.value), sdcard_profile: 0,
      radios: bluetooth ? client.state.settings?.radios ?? 0 : selectedRadios() };
    try {
      const wireless = bluetooth ? null : wirelessForm.request();
      const saved = await client.saveConfiguration({ settings, wireless });
      if (!current()) return;
      if (saved) wirelessForm.finish(saved);
      setUi({ settings_dirty: false, settings_message: "Settings saved. Waiting for the board to reboot." });
    } catch (error) {
      if (!current()) return;
      if (!bluetooth && wirelessForm.dirty()) wirelessForm.finish(null, describe(error));
      setUi({ settings_message: `Save failed: ${describe(error)}` });
    }
  }));
  settingsReboot.addEventListener("click", () => {
    if (settingsReboot.disabled) return;
    element("reboot-consequence").textContent = client.state.wireless?.staged_mask
      || client.state.wireless?.staged_state & STAGED_EXPIRED
      ? "Staged wireless credentials and their expiry marker will be discarded."
      : ui.getState().settings_dirty || wirelessForm.dirty()
      ? "Unsaved dashboard changes will be lost." : "Saved next-boot settings will be applied.";
    rebootDialog.showModal();
  });
  element("confirm-reboot").addEventListener("click", () => run(async () => {
    if (!rebootDialog.open) return;
    rebootDialog.close();
    if (!settingsReboot.disabled) await client.reboot(true);
  }));
  for (const [name, dialog] of /** @type {[string, HTMLDialogElement][]} */ (
    [["configuration", configurationDialog], ["reboot", rebootDialog]])) {
    element(`cancel-${name}`).addEventListener("click", () => dialog.close());
  }
  // ponytail: handle Escape on keydown instead of relying on the native cancel event, because a repeated Escape may
  // close a modal without a cancelable cancel event; connection dialogs stay open while a link is being set up.
  for (const dialog of [usbDialog, bluetoothDialog, configurationDialog, rebootDialog, mscDialog]) {
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!client.state.busy || ![usbDialog, bluetoothDialog].includes(dialog)) dialog.close();
    });
  }
  refresh();
  return {
    refresh: scheduleRefresh,
    dispose() {
      disposed = true;
      unwatch();
      wirelessForm.dispose();
    },
  };
}
