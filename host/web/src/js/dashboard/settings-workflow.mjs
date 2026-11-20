// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { DashboardError, responseJson, savedSettings, savedWireless } from "./api.mjs";
import { hasUnknownOutcome, isUncertainOutcome } from "./command-lifecycle.mjs";
import { CAPABILITY_WIRELESS } from "./operation-state.mjs";

/**
 * @typedef {import("./api.mjs").BootSettings} BootSettings
 * @typedef {import("./api.mjs").StatusSnapshot} DashboardSnapshot
 * @typedef {import("./api.mjs").ControlResult} ControlResult
 * @typedef {import("./operation-state.mjs").OperationState} OperationState
 * @typedef {import("./operation-state.mjs").Recovery} Recovery
 * @typedef {import("./command-lifecycle.mjs").CommandLifecycleOptions} CommandLifecycleOptions
 * @typedef {Pick<ReturnType<typeof import("./wireless-form.mjs").bindWirelessForm>,
 *   "credentialActions" | "dirty" | "finish" | "request" | "saveIdentity" | "selectedRadios">} WirelessDraft
 * @typedef {{
 *   getCurrentSnapshot: () => DashboardSnapshot | null,
 *   wireless: WirelessDraft,
 *   operationState: () => OperationState,
 *   runCommandLifecycle: (options: CommandLifecycleOptions, run: () => Promise<unknown>,
 *     failed: (error: Error) => void) => Promise<unknown>,
 *   boardUrl: (path: string) => string,
 *   fetchWithDeadline: (url: string, options: RequestInit, timeoutMs: number) => Promise<Response>,
 *   publishCommandResult: (result: ControlResult) => void,
 *   markCommandOutcomeUncertain: (error: Error, message?: string, recovery?: Recovery) => boolean,
 *   setMessage: (message: string | null) => void,
 *   changed: () => void,
 * }} SettingsWorkflowOptions
 */

/** Owns the boot-settings draft, its confirmation and the plain or combined wireless save.
 * @param {SettingsWorkflowOptions} options
 */
export function createSettingsWorkflow({
  getCurrentSnapshot, wireless, operationState, runCommandLifecycle, boardUrl, fetchWithDeadline,
  publishCommandResult, markCommandOutcomeUncertain, setMessage, changed,
}) {
  /** @param {string} id */
  const element = id => {
    const node = document.querySelector(`#${id}`);
    if (!node) throw new Error(`Missing dashboard element: ${id}`);
    return /** @type {HTMLElement} */ (node);
  };
  const dialog = /** @type {HTMLDialogElement} */ (element("configuration-dialog"));
  /** @type {Partial<Pick<BootSettings, "system_clock_mhz">>} */
  let draft = {};
  /** Proposal shown in the open confirmation dialog; a save is refused if it changed meanwhile.
   * @type {string | null}
   */
  let confirmedIdentity = null;

  dialog.addEventListener("close", () => { confirmedIdentity = null; });

  const wirelessSupported = () =>
    Boolean((getCurrentSnapshot()?.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS);

  /** @returns {BootSettings} */
  function selected() {
    const saved = getCurrentSnapshot()?.settings;
    return {
      system_clock_mhz: draft.system_clock_mhz ?? saved?.system_clock_mhz ?? 0,
      sdcard_profile: 0,
      radios: wirelessSupported() ? wireless.selectedRadios(saved?.radios ?? 0) : 0,
    };
  }

  function dirty() {
    const saved = getCurrentSnapshot()?.settings;
    const next = selected();
    return Boolean(saved && (next.system_clock_mhz !== saved.system_clock_mhz
      || next.sdcard_profile !== saved.sdcard_profile || next.radios !== saved.radios));
  }

  const identity = () => JSON.stringify([selected(), wireless.saveIdentity()]);

  function clearDraft() {
    draft = {};
  }

  /** @param {string} raw */
  function setClock(raw) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid system_clock_mhz: ${raw}`);
    if (value === getCurrentSnapshot()?.settings?.system_clock_mhz) delete draft.system_clock_mhz;
    else draft.system_clock_mhz = value;
    setMessage(null);
    changed();
  }

  function confirm() {
    if (!operationState().canSaveSettings) return;
    element("configuration-wireless-warning").hidden = !wireless.dirty();
    const settings = selected();
    const credentials = wireless.credentialActions();
    confirmedIdentity = identity();
    element("configuration-dialog-profile").textContent =
      `System clock: ${settings.system_clock_mhz ? `${settings.system_clock_mhz} MHz` : "Default"}.`
      + (wirelessSupported() ? ` Wi-Fi: ${settings.radios & 1 ? "Enabled" : "Disabled"}.`
        + ` Bluetooth: ${settings.radios & 2 ? "Enabled" : "Disabled"}.`
        + ` Wi-Fi credentials: ${credentials.wifi}. Bluetooth key: ${credentials.ble}.` : "");
    dialog.showModal();
  }

  /** Save board settings and credentials in one firmware commit; failures before delivery stay retryable.
   * @param {BootSettings} settings
   */
  async function saveCombined(settings) {
    const request = { ...wireless.request(), wifi_enabled: Boolean(settings.radios & 1),
      ble_enabled: Boolean(settings.radios & 2), board: settings };
    try {
      const response = await fetchWithDeadline(boardUrl("/api/wireless"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      }, 15000);
      const result = await responseJson(response, `Wireless endpoint returned HTTP ${response.status}`, true);
      if (result.reboot_pending === true) publishCommandResult({ opcode: 5, status: "completed" });
      const saved = savedWireless(result, request);
      const confirmed = savedSettings(result, settings);
      wireless.finish(saved);
      return confirmed;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const uncertain = isUncertainOutcome(error) || hasUnknownOutcome(error)
        || (error instanceof DashboardError && typeof error.uncertain !== "boolean" && (error.status ?? 0) >= 500);
      const failure = uncertain && !(error instanceof DashboardError && error.uncertain)
        ? new DashboardError("Wireless provisioning outcome is uncertain; use Re-sync before retrying.",
          undefined, true)
        : error;
      wireless.finish(null, failure.message);
      throw failure;
    }
  }

  /** @param {BootSettings} settings */
  async function savePlain(settings) {
    const response = await fetchWithDeadline(boardUrl("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }, 15000);
    const result = await responseJson(response, `Settings endpoint returned HTTP ${response.status}`, true);
    publishCommandResult({ opcode: 5, status: "completed" });
    return savedSettings(result, settings);
  }

  async function save() {
    if (!dialog.open) return;
    const proposal = confirmedIdentity;
    dialog.close();
    const operations = operationState();
    const snapshot = getCurrentSnapshot();
    if (!snapshot || !operations.canSaveSettings) {
      setMessage(operations.saveBlockReason ?? "Board state changed. Review the settings and confirm again.");
      changed();
      return;
    }
    if (proposal !== identity()) {
      setMessage("The proposed configuration changed. Review the settings and confirm again.");
      changed();
      return;
    }
    const combined = wireless.dirty();
    const settings = selected();
    await runCommandLifecycle({
      startMessage: "Saving boot settings...",
      clearFailure: 5,
      updateBoardControls: true,
      refresh: "uncertain",
    }, async () => {
      snapshot.settings = combined ? await saveCombined(settings) : await savePlain(settings);
      if (!combined) snapshot.settings_supported = true;
      draft = {};
      setMessage("Settings saved. Reboot requested. Waiting for the device to reconnect.");
    }, error => {
      if (markCommandOutcomeUncertain(error, undefined,
        combined ? { kind: "resync" } : { kind: "settings", expected: settings })) {
        setMessage(combined
          ? "Wireless save outcome is uncertain; use Re-sync before retrying."
          : "Save outcome is uncertain; checking status before allowing another save.");
      } else setMessage(`Save failed: ${error.message}`);
    });
  }

  return { clearDraft, confirm, dirty, save, selected, setClock };
}
