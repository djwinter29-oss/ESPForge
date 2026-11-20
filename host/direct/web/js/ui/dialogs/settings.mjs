// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file Configuration-save and reboot dialog handlers.
 */
import { CAP, RADIOS, STAGED_EXPIRED } from "../../protocol/constants.mjs";
import { describe, UI_TEXT } from "../messages.mjs";
import { queryElement } from "../dom.mjs";
import { captureBoardTarget, boardTargetDescription, runBoardConfirmation } from "./board-confirmation.mjs";

/**
 * @typedef {{getSession: () => import("../../board/session.mjs").BoardSession,
 *   run: (operation: () => Promise<void>) => void,
 *   setUi: (changes: Partial<import("../../state/reducer.mjs").UiState>) => void,
 *   ui: ReturnType<typeof import("../../state/store.mjs").createUiStore>,
 *   wirelessForm: ReturnType<typeof import("../sections/wireless-form/wireless-form.mjs").bindWirelessForm>,
 *   isDisposed: () => boolean}} SettingsDialogOptions
 */

/**
 * @brief Bind settings save/reboot dialogs and expose them for disconnect and Escape handling.
 * @param {SettingsDialogOptions} options
 * @return {{dialogs: HTMLDialogElement[], close: () => void}}
 */
export function mountSettingsDialogs({ getSession, run, setUi, ui, wirelessForm, isDisposed }) {
  /** @param {string} id */
  const element = id => queryElement(`#${id}`);
  /** @param {string} id */
  const button = id => queryElement(`button#${id}`);
  const settingsSave = button("settings-save");
  const settingsReboot = button("settings-reboot");
  const settingsClock = queryElement("select#settings-clock");
  const settingsRadios = [
    queryElement("select#direct-settings-wifi"),
    queryElement("select#direct-settings-ble"),
  ];
  const configurationDialog = queryElement("dialog#configuration-dialog");
  const rebootDialog = queryElement("dialog#reboot-dialog");
  const dialogs = [configurationDialog, rebootDialog];
  /** @type {ReturnType<typeof captureBoardTarget> | null} */
  let configurationTarget = null;
  /** @type {ReturnType<typeof captureBoardTarget> | null} */
  let rebootTarget = null;
  configurationDialog.addEventListener("close", () => { configurationTarget = null; });
  rebootDialog.addEventListener("close", () => { rebootTarget = null; });
  const selectedRadios = () => {
    const session = getSession();
    return session.state.hardware?.capabilities & CAP.WIRELESS
      ? Number(settingsRadios[0].value) | Number(settingsRadios[1].value) << 1 : 0;
  };
  const bluetoothLink = () => getSession().state.link === "ble";

  for (const control of [settingsClock, ...settingsRadios]) {
    control.addEventListener("change", () => {
      const settings = getSession().state.settings;
      setUi({ settings_dirty: Number(settingsClock.value) !== settings?.system_clock_mhz
        || selectedRadios() !== (settings?.radios ?? 0) });
    });
  }
  settingsSave.addEventListener("click", () => {
    if (settingsSave.disabled) return;
    const session = getSession();
    const bluetooth = bluetoothLink();
    const wirelessWarning = element("direct-configuration-wireless-warning");
    wirelessWarning.textContent = UI_TEXT.wirelessSaveWarning;
    wirelessWarning.hidden = bluetooth || !wirelessForm.dirty();
    const wifiEnabled = !bluetooth && session.state.hardware?.capabilities & CAP.WIRELESS
      ? Boolean(selectedRadios() & RADIOS.WIFI) : null;
    const bleEnabled = wifiEnabled === null ? false : Boolean(selectedRadios() & RADIOS.BLE);
    element("configuration-dialog-profile").textContent =
      UI_TEXT.configurationProfile(Number(settingsClock.value), wifiEnabled, bleEnabled);
    configurationTarget = captureBoardTarget(session);
    element("configuration-board-target").textContent = boardTargetDescription(session);
    configurationDialog.showModal();
  });
  element("confirm-configuration").addEventListener("click", () => run(async () => {
    if (!configurationDialog.open) return;
    const target = configurationTarget;
    configurationTarget = null;
    configurationDialog.close();
    await runBoardConfirmation(target, getSession, message => setUi({ settings_message: message }),
      UI_TEXT.settingsBoardChanged, async owner => {
        if (settingsSave.disabled) return;
        const bluetooth = bluetoothLink();
        const blocked = bluetooth ? null : wirelessForm.saveBlockReason();
        if (blocked) {
          setUi({ settings_message: blocked });
          return;
        }
        const signal = wirelessForm.signal;
        const generation = owner.connectionGeneration;
        const current = () => !isDisposed() && getSession() === owner && !signal.aborted
          && owner.connectionGeneration === generation;
        const settings = { system_clock_mhz: Number(settingsClock.value), sdcard_profile: 0,
          radios: bluetooth ? owner.state.settings?.radios ?? 0 : selectedRadios() };
        try {
          const wireless = bluetooth ? null : wirelessForm.request();
          const saved = await owner.saveConfiguration({ settings, wireless });
          if (!current()) return;
          if (saved) wirelessForm.finish(saved);
          setUi({ settings_dirty: false, settings_message: UI_TEXT.settingsSaved });
        } catch (error) {
          if (!current()) return;
          if (!bluetooth && wirelessForm.dirty()) wirelessForm.finish(null, describe(error));
          setUi({ settings_message: UI_TEXT.settingsSaveFailed(describe(error)) });
        }
      });
  }));
  settingsReboot.addEventListener("click", () => {
    if (settingsReboot.disabled) return;
    const session = getSession();
    const staged = session.state.wireless?.staged_mask
      || session.state.wireless?.staged_state & STAGED_EXPIRED;
    const unsaved = ui.getState().settings_dirty || wirelessForm.dirty();
    element("reboot-consequence").textContent = UI_TEXT.rebootConsequence(Boolean(staged), unsaved);
    rebootTarget = captureBoardTarget(session);
    element("reboot-board-target").textContent = boardTargetDescription(session);
    rebootDialog.showModal();
  });
  element("confirm-reboot").addEventListener("click", () => run(async () => {
    if (!rebootDialog.open) return;
    const target = rebootTarget;
    rebootTarget = null;
    rebootDialog.close();
    await runBoardConfirmation(target, getSession, message => setUi({ settings_message: message }),
      UI_TEXT.rebootBoardChanged, async session => {
        if (!settingsReboot.disabled) await session.reboot(true);
      });
  }));
  for (const [name, dialog] of /** @type {[string, HTMLDialogElement][]} */ (
    [["configuration", configurationDialog], ["reboot", rebootDialog]])) {
    element(`cancel-${name}`).addEventListener("click", () => dialog.close());
  }
  return { dialogs, close: () => dialogs.forEach(dialog => dialog.close()) };
}
