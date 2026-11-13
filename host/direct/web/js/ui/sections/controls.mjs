// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { canRun } from "../../state/selectors.mjs";
import { queryElement, setText } from "../dom.mjs";
import { describe } from "../messages.mjs";

const element = id => queryElement(`#${id}`);

/**
 * @typedef {{eligibility: ReturnType<typeof import("../../state/selectors.mjs").deriveOperationEligibility>,
 *   formBusy: boolean, settingsMessage: string | null, bleName: string | null, settingsDirty: boolean,
 *   wirelessDirty: boolean, wirelessSaveBlockReason: string | null}} ControlsUi
 */

export function deriveClockOptions(mcu, savedClock) {
  const choices = mcu === "ESP32-S3"
    ? [[0, "Default (240 MHz)"], [80, "80 MHz"], [160, "160 MHz"], [240, "240 MHz"]] : [[0, "Default"]];
  const unsupported = Number.isInteger(savedClock) && savedClock !== 0
    && !choices.some(([value]) => value === savedClock) ? savedClock : null;
  return {
    signature: `${mcu ?? "unknown"}:${unsupported ?? ""}`,
    choices: [...choices, ...(unsupported === null ? [] : [[unsupported, `${unsupported} MHz (saved; unsupported)`, true]])],
  };
}

export function renderClockOptions(state) {
  const model = deriveClockOptions(state.hardware?.mcu, state.settings?.system_clock_mhz);
  const select = queryElement("select#settings-clock");
  if (select.dataset.clockOptions === model.signature || typeof select.replaceChildren !== "function") return;
  const previous = select.value;
  const options = model.choices.map(([value, label, disabled = false]) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    option.disabled = disabled;
    return option;
  });
  select.replaceChildren(...options);
  select.dataset.clockOptions = model.signature;
  select.value = options.some(option => option.value === previous) ? previous : "0";
}

/**
 * @brief Derive control labels, notes and gates. Operation gates come from `canRun`, so a disabled button and a
 * refused session call share one reason (shown as the button title).
 * @param {import("./status-model.mjs").DashboardPresentation} state Domain snapshot with display-text errors.
 * @param {ControlsUi} ui
 * @param {Pick<import("../dashboard.mjs").DashboardEnvironment, "secure" | "hid" | "ble">} environment
 */
export function deriveControlsViewModel(state, ui, environment) {
  const bluetooth = state.link === "ble";
  const { eligibility } = ui;
  const { storageReady } = eligibility;
  const reason = operation => ui.formBusy ? "Finish the wireless operation first."
    : describe(canRun(state, operation, eligibility).reason);
  const reasons = { "settings-reboot": reason("reboot"),
    "settings-save": ui.wirelessSaveBlockReason || reason("settings") };
  const bleLinked = bluetooth && (state.connected || state.reconnecting);
  const usbUnsupported = !environment.secure || !environment.hid;
  const bleUnsupported = !environment.secure || !environment.ble;
  const settingsNote = ui.settingsMessage || (!state.connected ? "Connect to read the saved settings."
    : !state.settings_supported ? "Persistent settings save is unavailable."
      : !storageReady ? "Waiting for fresh storage status."
        : bluetooth ? "Over Bluetooth, clock and reboot are available; "
          + "radio and credential provisioning remain USB-only." : "");
  return {
    settingsValues: !ui.settingsDirty ? state.settings : null,
    settingsDisabled: !eligibility.settingsReady || !state.settings_supported,
    titles: Object.fromEntries(Object.entries(reasons).map(([id, text]) => [id, text ?? ""])),
    disabled: {
      "msc-enable": !eligibility.mscReady || state.memory?.msc?.enabled === true || !state.memory?.initialized,
      "msc-return": !eligibility.mscReady || state.memory?.msc?.enabled !== true,
      "usb-open": Boolean(state.busy || eligibility.connectionLocked && bluetooth),
      "bluetooth-open": Boolean(state.busy || eligibility.connectionLocked && !bluetooth),
      "usb-connect": Boolean(state.busy || bluetooth || usbUnsupported),
      "bluetooth-scan": Boolean(state.busy || !bluetooth || !bleLinked && bleUnsupported),
      "direct-ble-control-key": Boolean(state.busy || !bluetooth || bleLinked || bleUnsupported),
      "usb-connection-close": Boolean(state.busy),
      "bluetooth-connection-close": Boolean(state.busy),
      "settings-save": Boolean(reasons["settings-save"]) || !ui.settingsDirty && !ui.wirelessDirty,
      "settings-reboot": Boolean(reasons["settings-reboot"]),
    },
    text: {
      "usb-connect": !bluetooth && (state.connected || state.reconnecting) ? "Disconnect" : "Select board",
      "bluetooth-scan": bleLinked ? "Disconnect" : "Scan for boards",
      "usb-connection-status": usbUnsupported ? "USB HID requires a supported browser on HTTPS or localhost."
        : !bluetooth && state.error ? state.error : !bluetooth && state.busy ? "Connecting to the selected USB board…"
          : !bluetooth && state.reconnecting ? "Reconnecting to the USB board…"
            : !bluetooth && state.connected ? "Connected through USB." : "Select an ESPForge board to connect.",
      "bluetooth-connection-status": bleUnsupported
        ? "Web Bluetooth requires a supported browser and operating system on HTTPS or localhost."
        : bluetooth && state.error ? state.error : bluetooth && state.busy ? "Select a nearby board; connecting through Bluetooth…"
          : bluetooth && state.connected ? `Connected to ${ui.bleName || state.hardware?.board_name || "ESPForge"}.`
            : "Enter the control key, then scan for nearby ESPForge boards.",
      "settings-note": settingsNote,
    },
    hideStatus: !state.error && Boolean(settingsNote),
  };
}

/** @copydoc deriveControlsViewModel */
/** @type {(state: Parameters<typeof deriveControlsViewModel>[0], ui: ControlsUi,
 *   environment: Parameters<typeof deriveControlsViewModel>[2]) => void} */
export function renderControls(state, ui, environment) {
  const model = deriveControlsViewModel(state, ui, environment);
  element("msc-controls").hidden = !((state.settings?.board_flags ?? 0) & 64) || state.link === "ble";
  if (model.settingsValues) {
    queryElement("select#settings-clock").value = String(model.settingsValues.system_clock_mhz);
    ["direct-settings-wifi", "direct-settings-ble"].forEach((id, bit) => {
      queryElement(`select#${id}`).value = String(model.settingsValues.radios >> bit & 1);
    });
  }
  setText(model.text);
  queryElement("select#settings-clock").disabled = model.settingsDisabled;
  for (const [id, disabled] of Object.entries(model.disabled)) {
    if (id === "direct-ble-control-key") queryElement(`input#${id}`).disabled = disabled;
    else queryElement(`button#${id}`).disabled = disabled;
  }
  for (const [id, title] of Object.entries(model.titles)) element(id).title = title;
  element("settings-note").hidden = !model.text["settings-note"];
  element("status-message").hidden = model.hideStatus;
}
