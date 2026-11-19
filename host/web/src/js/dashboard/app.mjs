// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { initializeSettings, normalizeStatus, renderStatus as renderDashboardStatus } from "./view.mjs";
import { createBoardSession } from "./board-session.mjs";
import { createCommandLifecycle } from "./command-lifecycle.mjs";
import { createDeviceActions } from "./device-actions.mjs";
import { bindWirelessForm } from "./wireless-form.mjs";
import {
  DashboardError, reconciledResult, responseJson, savedSettings, savedWireless,
  scannedNetworks, testedWireless,
  wirelessConfiguration,
} from "./api.mjs";
import {
  CAPABILITY_WIRELESS, commandEffects, createCommandState, observeCommandStatus,
  operationState as deriveOperationState,
} from "./operation-state.mjs";

const commandResync = /** @type {HTMLButtonElement} */ (document.querySelector("#command-resync"));
const boardSelect = /** @type {HTMLSelectElement} */ (document.querySelector("#board-select"));
const rescanBoardsButton = /** @type {HTMLButtonElement} */ (document.querySelector("#rescan-boards"));
const settingsSave = /** @type {HTMLButtonElement} */ (document.querySelector("#settings-save"));
const configurationDialog = /** @type {HTMLDialogElement} */ (document.querySelector("#configuration-dialog"));
const rebootDialog = /** @type {HTMLDialogElement} */ (document.querySelector("#reboot-dialog"));
const mscDialog = /** @type {HTMLDialogElement} */ (document.querySelector("#msc-dialog"));
/** @type {string | null} */
let configurationIdentity = null;
const clockControl = /** @type {HTMLSelectElement} */ (document.querySelector("#settings-clock"));
const rebootControl = /** @type {HTMLButtonElement} */ (document.querySelector("#reboot-control"));
const identityDetails = ["product-information", "module-memory"]
  .map(id => /** @type {HTMLDetailsElement} */ (element(id)));
/** @type {ReturnType<typeof createBoardSession>} */
let boardSession;
for (const details of identityDetails) {
  const show = () => {
    for (const other of identityDetails) other.open = other === details;
  };
  details.addEventListener("pointerenter", event => {
    if (event.pointerType === "mouse") show();
  });
  details.addEventListener("pointerleave", () => {
    if (!details.contains(document.activeElement)) details.open = false;
  });
  details.addEventListener("focusin", () => {
    // Pointer focus precedes the native summary toggle; only keyboard focus opens a preview.
    if (document.activeElement?.matches(":focus-visible")) show();
  });
  details.addEventListener("focusout", () => {
    if (!details.matches(":hover")) details.open = false;
  });
  details.addEventListener("keydown", event => {
    if (event.key === "Escape") details.open = false;
  });
}
/** @param {string} id */
function element(id) {
  const node = /** @type {HTMLElement | null} */ (document.querySelector(`#${id}`));
  if (!node) throw new Error(`Missing dashboard element: ${id}`);
  return node;
}
/** @param {string} url @param {RequestInit} options @param {number} timeoutMs */
const fetchWithDeadline = (url, options, timeoutMs) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
/** @typedef {import("./api.mjs").StatusSnapshot} DashboardSnapshot
 */
/** @type {DashboardSnapshot | null} */
let currentSnapshot = null;
let disconnectedUi = false;
let commandResyncInProgress = false;
let settingsRequestInProgress = false;
/** @type {Partial<Pick<import("./api.mjs").BootSettings, "system_clock_mhz">>} */
let settingsDraft = {};
/** @type {string | null} */
let settingsMessage = null;
/** @type {((phase: string) => void) | null} */
let wirelessProgress = null;
let boardState = createCommandState();
/** @type {Map<string, import("./operation-state.mjs").BoardCommandState>} */
const boardCommandStates = new Map();
/** @param {string} boardId */
function commandStateFor(boardId) {
  let state = boardCommandStates.get(boardId);
  if (!state) { state = createCommandState(); boardCommandStates.set(boardId, state); }
  return state;
}
/** @param {unknown} error */
function hasUnknownOutcome(error) {
  return error instanceof Error && ["AbortError", "TimeoutError", "UnknownOutcomeError"].includes(error.name)
    || error instanceof TypeError;
}
/** @param {unknown} error */
function isUncertainOutcome(error) {
  if (error instanceof DashboardError && typeof error.uncertain === "boolean") return error.uncertain;
  return error instanceof Error && /uncertain|outcome.*not resent/i.test(error.message);
}
/** @param {Error} error @param {string} fallback */
function uncertainMessage(error, fallback) {
  return isUncertainOutcome(error) && /uncertain|outcome.*not resent/i.test(error?.message ?? "")
    ? error.message : fallback;
}
/** @param {Error} error @param {string} [message]
 * @param {import("./operation-state.mjs").Recovery} [recovery] @param {string | null} [boardId]
 */
function markCommandOutcomeUncertain(error, message =
  "Command outcome is uncertain. Use Re-sync before retrying.", recovery = { kind: "reconnect" },
  boardId = boardSession.state().selectedBoard) {
  if (!hasUnknownOutcome(error)) return false;
  const command = { ...recovery, message };
  if (boardId !== boardSession.state().selectedBoard) {
    if (boardId) commandStateFor(boardId).uncertainCommand = command;
    return true;
  }
  boardState.uncertainCommand = command;
  if (currentSnapshot) {
    currentSnapshot.error = message;
  }
  return true;
}
/** @typedef {import("./operation-state.mjs").OperationSnapshot} OperationSnapshot */
/** @typedef {import("./operation-state.mjs").OperationState} OperationState */
/** @param {OperationSnapshot | null} [snapshot] @returns {OperationState} */
function operationState(snapshot = currentSnapshot) {
  return deriveOperationState(snapshot, {
    uncertain: boardState.uncertainCommand !== null, rebootPending: boardState.rebootPending !== null,
    resyncing: commandResyncInProgress, saving: settingsRequestInProgress,
    wirelessBusy: wirelessForm.operationBusy(), wirelessInFlight: wirelessForm.inFlight(),
    statusFailed: boardSession.state().statusError !== null, scanning: boardSession.state().scanning,
    radiosDirty: wirelessForm.radioEdited("wifi") || wirelessForm.radioEdited("ble"),
    settingsDirty: settingsDirty(), wirelessDirty: wirelessForm.dirty(),
    wirelessBlockReason: wirelessForm.saveBlockReason(),
  });
}

/** Apply the same confirmed lifecycle effects for ordinary acknowledgements and explicit Re-sync.
 * @param {import("./api.mjs").ControlResult} result
 */
function publishCommandResult(result) {
  const effects = commandEffects(result);
  if (effects.reboot) boardState.rebootPending = "requested";
  if (effects.wifiCancel) {
    if (effects.completed && currentSnapshot) currentSnapshot.wireless_cleanup_required = false;
    wirelessForm.cancelResolved(effects.completed);
  }
  if (effects.failure) boardState.commandFailure = { opcode: result.opcode, message: effects.failure };
  else clearCommandFailure(result.opcode);
  if (effects.completed && result.opcode === 4 && currentSnapshot) {
    currentSnapshot.storage_stale = true;
    currentSnapshot.self_test_stale = true;
  }
}
/** @param {number} opcode */
function clearCommandFailure(opcode) {
  if (boardState.commandFailure?.opcode === opcode) boardState.commandFailure = null;
}
const runCommandLifecycle = createCommandLifecycle({
  begin: options => {
    boardSession.commandChanged();
    settingsRequestInProgress = true;
    if (options.clearFailure !== undefined) clearCommandFailure(options.clearFailure);
    if (options.startMessage !== undefined) settingsMessage = options.startMessage;
    if (currentSnapshot) renderStatus(currentSnapshot);
  },
  finish: options => {
    boardSession.commandChanged();
    settingsRequestInProgress = false;
    if (options.updateBoardControls) updateBoardSelectionControls();
    if (currentSnapshot) renderStatus(currentSnapshot);
    if (options.refresh === "always" || options.refresh === "uncertain" && boardState.uncertainCommand)
      void boardSession.updateStatus();
  },
});
const wirelessForm = bindWirelessForm({
  supported: () => Boolean((currentSnapshot?.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS),
  cleanupRequired: () => Boolean(currentSnapshot?.wireless_cleanup_required),
  ready: wirelessReady,
  scan: async () => {
    const boardId = boardSession.state().selectedBoard;
    boardSession.commandChanged();
    try {
      const response = await fetchWithDeadline(boardUrl("/api/wireless/scan", boardId), { method: "POST" }, 20000);
      const result = await responseJson(response, `Wireless scan returned HTTP ${response.status}`, true);
      return scannedNetworks(result);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId);
      throw error;
    } finally {
      boardSession.commandChanged();
    }
  },
  test: async (settings, onProgress) => {
    const version = boardSession.state().selectionVersion;
    const boardId = boardSession.state().selectedBoard;
    boardSession.commandChanged();
    wirelessProgress = onProgress;
    try {
      const response = await fetchWithDeadline(boardUrl("/api/wireless/test"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
      }, 40000);
      const result = await responseJson(response, `Connection test returned HTTP ${response.status}`, true);
      return testedWireless(result.test);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId);
      if (error instanceof TypeError || ["TimeoutError", "AbortError"].includes(error?.name)) {
        throw new Error(error.name === "TimeoutError"
          ? "Wi-Fi test timed out; result is uncertain. Use Re-sync before retrying."
          : "Wi-Fi test result was lost. Use Re-sync before retrying.");
      }
      throw error;
    } finally {
      boardSession.commandChanged();
      if (version === boardSession.state().selectionVersion) wirelessProgress = null;
    }
  },
  cancelTest: async () => {
    const boardId = boardSession.state().selectedBoard;
    boardSession.commandChanged();
    try {
      const response = await fetchWithDeadline(boardUrl("/api/wireless/cancel"), { method: "POST" }, 10000);
      const result = await responseJson(response, `Cancel returned HTTP ${response.status}`, true);
      if (result.cancelled !== true)
        throw new DashboardError("Invalid wireless cancellation response; outcome is uncertain", undefined, true);
      return result;
    }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId);
      throw error;
    } finally {
      boardSession.commandChanged();
    }
  },
  changed: () => { if (currentSnapshot) renderStatus(currentSnapshot); },
});
boardSession = createBoardSession({
  boardSelect,
  rescanButton: rescanBoardsButton,
  fetchWithDeadline,
  normalizeSnapshot: normalizeStatus,
  getOperationState: operationState,
  statusBlocked: () => settingsRequestInProgress,
  onStatus: snapshot => {
    if (!commandResyncInProgress
      && observeCommandStatus(boardState, snapshot)?.kind === "settings") {
      settingsDraft = {};
      settingsMessage = "Settings readback matches the requested values.";
    }
    currentSnapshot = snapshot;
    acceptConnection(snapshot);
    if (currentSnapshot.wireless_phase) wirelessProgress?.(currentSnapshot.wireless_phase);
    if (wirelessReady() && currentSnapshot.wireless) wirelessForm.initialize(currentSnapshot.wireless);
    initializeSettings({ ...snapshot, ...settingsEditState() });
    renderStatus(currentSnapshot);
  },
  onStatusError: error => {
    const failedSnapshot = currentSnapshot?.connected
      ? { ...currentSnapshot, error: `Status unavailable: ${error.message}`,
        telemetry_stale: true, storage_stale: true }
      : { connected: false, error: error.message };
    renderStatus(failedSnapshot);
  },
  onScanError: error => {
    const message = `Board scan failed: ${error.message}`;
    if (currentSnapshot?.connected) {
      currentSnapshot = { ...currentSnapshot, error: message };
      renderStatus(currentSnapshot);
    } else {
      renderStatus({ connected: false, error: message });
    }
  },
  onSelectionChanged: (boardId, source) => {
    configurationDialog.close();
    rebootDialog.close();
    mscDialog.close();
    disconnectedUi = false;
    currentSnapshot = null;
    acceptConnection({ connected: false });
    settingsDraft = {};
    if (source === "select") settingsMessage = null;
    boardState = boardId ? commandStateFor(boardId) : createCommandState();
    renderStatus({ connected: false });
  },
});
const deviceActions = createDeviceActions({
  getCurrentSnapshot: () => currentSnapshot,
  getSelectedBoard: () => boardSession.state().selectedBoard,
  operationState,
  runCommandLifecycle,
  boardUrl,
  fetchWithDeadline,
  publishCommandResult,
  markCommandOutcomeUncertain,
  uncertainMessage,
  setSettingsMessage: message => { settingsMessage = message; },
});

function wirelessReady() {
  return operationState().canProvisionWireless && !wirelessForm.inFlight();
}

/** Save board settings and credentials in one firmware commit; failures before delivery stay retryable.
 * @param {import("./api.mjs").BootSettings} settings
 */
async function saveCombinedSettings(settings) {
  const request = { ...wirelessForm.request(), wifi_enabled: Boolean(settings.radios & 1),
    ble_enabled: Boolean(settings.radios & 2), board: settings };
  try {
    const response = await fetchWithDeadline(boardUrl("/api/wireless"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    }, 15000);
    const result = await responseJson(response, `Wireless endpoint returned HTTP ${response.status}`, true);
    if (result.reboot_pending === true) publishCommandResult({ opcode: 5, status: "completed" });
    const saved = savedWireless(result, request);
    const confirmed = savedSettings(result, settings);
    wirelessForm.finish(saved);
    return confirmed;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const uncertain = isUncertainOutcome(error) || hasUnknownOutcome(error)
      || (error instanceof DashboardError && typeof error.uncertain !== "boolean" && (error.status ?? 0) >= 500);
    const failure = uncertain && !(error instanceof DashboardError && error.uncertain)
      ? new DashboardError("Wireless provisioning outcome is uncertain; use Re-sync before retrying.", undefined, true)
      : error;
    wirelessForm.finish(null, failure.message);
    throw failure;
  }
}

/** @param {string} path @param {string | null} [boardId] */
function boardUrl(path, boardId) {
  return boardSession.boardUrl(path, boardId);
}

function updateBoardSelectionControls() {
  boardSession?.updateControls();
}

/** @param {DashboardSnapshot} snapshot */
function acceptConnection(snapshot) {
  if (snapshot.connected === true) disconnectedUi = false;
  else if (snapshot.connected === false && !disconnectedUi) {
    disconnectedUi = true;
    wirelessForm.reset();
    settingsDraft = {};
    settingsMessage = null;
  }
}

function settingsEditState() {
  return {
    settings_dirty: settingsDirty(),
    settings_draft: selectedSettings(),
  };
}

/** @param {DashboardSnapshot} snapshot */
function renderStatus(snapshot) {
  const operations = operationState(snapshot);
  updateBoardSelectionControls();
  const session = boardSession.state();
  renderDashboardStatus({
    ...snapshot,
    error: snapshot.error ?? (boardState.uncertainCommand ? snapshot.command_resync_supported
      ? boardState.uncertainCommand.message
        : "Command outcome is uncertain. Reconnect the board and reload the dashboard before retrying."
      : boardState.commandFailure?.message ?? session.scanWarning),
    no_board_selected: !session.selectedBoard,
    console_url: session.selectedBoard && session.statusError === null ? boardUrl("/console") : null,
    ...settingsEditState(),
    wireless_dirty: wirelessForm.dirty(),
    settings_message: settingsMessage ?? snapshot.settings_message,
    status_read_error: session.statusError !== null,
    status_reading: session.statusReading,
  }, operations);
  const discard = /** @type {HTMLButtonElement} */ (element("wireless-discard"));
  discard.hidden = !wirelessForm.conflicted();
  discard.disabled = !operations.canProvisionWireless;
  wirelessForm.update();
}

element("wireless-discard").addEventListener("click", async () => {
  if (!operationState().canProvisionWireless || !wirelessForm.conflicted()) return;
  boardSession.commandChanged();
  try {
    if (!await wirelessForm.discardEdits() || !currentSnapshot) return;
    currentSnapshot.wireless = null;
    renderStatus(currentSnapshot);
  } finally {
    boardSession.commandChanged();
    await boardSession.updateStatus();
  }
});

async function resyncCommandOutcome() {
  const operations = operationState();
  if (!operations.canRecover || !currentSnapshot) return;
  const version = boardSession.state().selectionVersion;
  boardSession.commandChanged();
  commandResyncInProgress = true;
  renderStatus(currentSnapshot);
  try {
    if (operations.recovery === "cleanup") {
      if (await wirelessForm.clearTest()) await boardSession.updateStatus();
      return;
    }
    const response = await fetchWithDeadline(boardUrl("/api/control/resync"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }, 10000);
    const result = await responseJson(response, `Command re-sync returned HTTP ${response.status}`, true);
    if (version !== boardSession.state().selectionVersion) return;
    const control = reconciledResult(result);
    boardState.uncertainCommand = null;
    currentSnapshot.command_outcome_uncertain = false;
    currentSnapshot.error = null;
    if (control) publishCommandResult(control);
    if (result.temporary_wifi_reset === true) {
      wirelessForm.cancelResolved(true, "Board restarted; the temporary Wi-Fi test was discarded. Test again.");
      currentSnapshot.wireless_cleanup_required = false;
    } else if (control?.opcode !== 10) wirelessForm.cancelResolved(false);
    if (result.wireless != null) currentSnapshot.wireless = wirelessConfiguration(result.wireless);
    if (result.control_result) currentSnapshot.control_result = result.control_result;
    await boardSession.updateStatus();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (version === boardSession.state().selectionVersion && currentSnapshot) currentSnapshot.error = error.message;
  } finally {
    boardSession.commandChanged();
    commandResyncInProgress = false;
    updateBoardSelectionControls();
    if (version === boardSession.state().selectionVersion && currentSnapshot) renderStatus(currentSnapshot);
  }
}

function selectedSettings() {
  const saved = currentSnapshot?.settings;
  return {
    system_clock_mhz: settingsDraft.system_clock_mhz ?? saved?.system_clock_mhz ?? 0,
    sdcard_profile: 0,
    radios: selectedRadios(),
  };
}

function selectedRadios() {
  const saved = currentSnapshot?.settings?.radios ?? 0;
  return (currentSnapshot?.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS
    ? wirelessForm.selectedRadios(saved) : 0;
}

function settingsDirty() {
  const saved = currentSnapshot?.settings;
  const selected = selectedSettings();
  return Boolean(saved && (selected.system_clock_mhz !== saved.system_clock_mhz
    || selected.sdcard_profile !== saved.sdcard_profile || selected.radios !== saved.radios));
}

function saveIdentity() {
  return JSON.stringify([selectedSettings(), wirelessForm.saveIdentity()]);
}

async function saveSettings() {
  if (!configurationDialog.open) return;
  const confirmedIdentity = configurationIdentity;
  configurationDialog.close();
  const operations = operationState();
  if (!currentSnapshot || !operations.canSaveSettings) {
    settingsMessage = operations.saveBlockReason ?? "Board state changed. Review the settings and confirm again.";
    if (currentSnapshot) renderStatus(currentSnapshot);
    return;
  }
  const snapshot = currentSnapshot;
  if (confirmedIdentity !== saveIdentity()) {
    settingsMessage = "The proposed configuration changed. Review the settings and confirm again.";
    renderStatus(snapshot);
    return;
  }
  const combined = wirelessForm.dirty();
  const settings = selectedSettings();
  await runCommandLifecycle({
    startMessage: "Saving boot settings...",
    clearFailure: 5,
    updateBoardControls: true,
    refresh: "uncertain",
  }, async () => {
    if (combined) {
      snapshot.settings = await saveCombinedSettings(settings);
    } else {
      const response = await fetchWithDeadline(boardUrl("/api/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }, 15000);
      const result = await responseJson(response, `Settings endpoint returned HTTP ${response.status}`, true);
      publishCommandResult({ opcode: 5, status: "completed" });
      snapshot.settings = savedSettings(result, settings);
      snapshot.settings_supported = true;
    }
    settingsDraft = {};
    settingsMessage = "Settings saved. Reboot requested. Waiting for the device to reconnect.";
  }, error => {
    if (markCommandOutcomeUncertain(error, undefined,
      combined ? { kind: "resync" } : { kind: "settings", expected: settings })) {
      settingsMessage = combined
        ? "Wireless save outcome is uncertain; use Re-sync before retrying."
        : "Save outcome is uncertain; checking status before allowing another save.";
    } else settingsMessage = `Save failed: ${error.message}`;
  });
}

element("led-colour").addEventListener("change", deviceActions.setLed);
element("benchmark-start").addEventListener("click", () => deviceActions.benchmark(true));
element("benchmark-cancel").addEventListener("click", () => deviceActions.benchmark(false));
element("msc-enable").addEventListener("click", () => deviceActions.requestMsc(true));
element("msc-return").addEventListener("click", () => deviceActions.requestMsc(false));
element("cancel-msc").addEventListener("click", () => mscDialog.close());
element("confirm-msc").addEventListener("click", deviceActions.setMsc);
boardSelect.addEventListener("change", () => boardSession.selectBoard(boardSelect.value));
rescanBoardsButton.addEventListener("click", boardSession.rescanBoards);
clockControl.addEventListener("change", () => {
  const value = Number(clockControl.value);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid system_clock_mhz: ${clockControl.value}`);
  if (value === currentSnapshot?.settings?.system_clock_mhz) delete settingsDraft.system_clock_mhz;
  else settingsDraft.system_clock_mhz = value;
  settingsMessage = null;
  if (currentSnapshot) renderStatus(currentSnapshot);
});
settingsSave.addEventListener("click", () => {
  if (!operationState().canSaveSettings) return;
  element("configuration-wireless-warning").hidden = !wirelessForm.dirty();
  const settings = selectedSettings();
  const credentials = wirelessForm.credentialActions();
  configurationIdentity = saveIdentity();
  element("configuration-dialog-profile").textContent =
    `System clock: ${settings.system_clock_mhz ? `${settings.system_clock_mhz} MHz` : "Default"}.`
    + ((currentSnapshot?.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS ? ` Wi-Fi: ${settings.radios & 1 ? "Enabled" : "Disabled"}.`
      + ` Bluetooth: ${settings.radios & 2 ? "Enabled" : "Disabled"}.`
      + ` Wi-Fi credentials: ${credentials.wifi}. Bluetooth key: ${credentials.ble}.` : "");
  configurationDialog.showModal();
});
rebootControl.addEventListener("click", () => {
  if (rebootControl.disabled) return;
  element("reboot-consequence").textContent = settingsDirty() || wirelessForm.dirty()
    ? "Unsaved dashboard changes will be lost." : "Saved next-boot settings will be applied.";
  rebootDialog.showModal();
});
element("cancel-configuration").addEventListener("click", () => configurationDialog.close());
element("cancel-reboot").addEventListener("click", () => rebootDialog.close());
commandResync.addEventListener("click", resyncCommandOutcome);
element("wifi-resync").addEventListener("click", resyncCommandOutcome);
configurationDialog.addEventListener("close", () => { configurationIdentity = null; });
for (const dialog of [configurationDialog, rebootDialog, mscDialog]) {
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.close();
    }
  });
}
element("confirm-configuration").addEventListener("click", saveSettings);
element("confirm-reboot").addEventListener("click", deviceActions.rebootDevice);
void boardSession.rescanBoards();
const pollWhenVisible = () => {
  return document.hidden ? Promise.resolve() : boardSession.updateStatus();
};
document.addEventListener?.("visibilitychange", pollWhenVisible);
window.setInterval(pollWhenVisible, 1000);