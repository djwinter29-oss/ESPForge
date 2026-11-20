// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import {
  bindIdentityPreviews, initializeSettings, normalizeStatus, renderStatus as renderDashboardStatus,
} from "./view.mjs";
import { createBoardSession } from "./board-session.mjs";
import { createCommandLifecycle, uncertainMessage } from "./command-lifecycle.mjs";
import { createCommandRecovery } from "./command-recovery.mjs";
import { createDeviceActions } from "./device-actions.mjs";
import { createSettingsWorkflow } from "./settings-workflow.mjs";
import { bindWirelessForm } from "./wireless-form.mjs";
import { createWirelessTransport } from "./wireless-transport.mjs";
import { CAPABILITY_WIRELESS, operationState as deriveOperationState } from "./operation-state.mjs";

/** @typedef {import("./api.mjs").StatusSnapshot} DashboardSnapshot */

/** @param {string} id */
function element(id) {
  const node = /** @type {HTMLElement | null} */ (document.querySelector(`#${id}`));
  if (!node) throw new Error(`Missing dashboard element: ${id}`);
  return node;
}
/** @param {string} id */
const dialog = id => /** @type {HTMLDialogElement} */ (element(id));
const boardSelect = /** @type {HTMLSelectElement} */ (element("board-select"));
const rescanBoardsButton = /** @type {HTMLButtonElement} */ (element("rescan-boards"));
const clockControl = /** @type {HTMLSelectElement} */ (element("settings-clock"));
const rebootControl = /** @type {HTMLButtonElement} */ (element("reboot-control"));
const configurationDialog = dialog("configuration-dialog");
const rebootDialog = dialog("reboot-dialog");
const mscDialog = dialog("msc-dialog");

/** @param {string} url @param {RequestInit} options @param {number} timeoutMs */
const fetchWithDeadline = (url, options, timeoutMs) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

/** @type {DashboardSnapshot | null} */
let currentSnapshot = null;
/** Set after the first disconnected status so drafts are discarded once per disconnection. */
let disconnectedUi = false;
/** A confirmed command is in flight; status reads wait until it finishes. */
let commandInProgress = false;
/** @type {string | null} */
let settingsMessage = null;

const refresh = () => { if (currentSnapshot) renderStatus(currentSnapshot); };
const getCurrentSnapshot = () => currentSnapshot;

const boardSession = createBoardSession({
  boardSelect,
  rescanButton: rescanBoardsButton,
  fetchWithDeadline,
  normalizeSnapshot: normalizeStatus,
  getOperationState: operationState,
  statusBlocked: () => commandInProgress,
  onStatus: snapshot => {
    const observation = recovery.observeStatus(snapshot);
    if (observation?.settledCommand?.kind === "settings") {
      settings.clearDraft();
      settingsMessage = "Settings readback matches the requested values.";
    }
    if (observation?.rebootSettled && /reboot requested/i.test(settingsMessage ?? ""))
      settingsMessage = null;
    currentSnapshot = snapshot;
    acceptConnection(snapshot);
    if (snapshot.wireless_phase) wirelessTransport.reportPhase(snapshot.wireless_phase);
    if (wirelessReady() && snapshot.wireless) wirelessForm.initialize(snapshot.wireless);
    initializeSettings({ ...snapshot, ...settingsEditState() });
    renderStatus(snapshot);
  },
  onStatusError: error => {
    renderStatus(currentSnapshot?.connected
      ? { ...currentSnapshot, error: `Status unavailable: ${error.message}`,
        telemetry_stale: true, storage_stale: true }
      : { connected: false, error: error.message });
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
    settings.clearDraft();
    if (source === "select") settingsMessage = null;
    recovery.selectBoard(boardId);
    renderStatus({ connected: false });
  },
});
const recovery = createCommandRecovery({
  session: boardSession,
  getCurrentSnapshot,
  operationState,
  fetchWithDeadline,
  wifiCancelResolved: (completed, message) => wirelessForm.cancelResolved(completed, message),
  clearWirelessTest: () => wirelessForm.clearTest(),
  changed: refresh,
});
const runCommandLifecycle = createCommandLifecycle({
  begin: options => {
    boardSession.commandChanged();
    commandInProgress = true;
    if (options.clearFailure !== undefined) recovery.clearFailure(options.clearFailure);
    if (options.startMessage !== undefined) settingsMessage = options.startMessage;
    refresh();
  },
  finish: options => {
    boardSession.commandChanged();
    commandInProgress = false;
    if (options.updateBoardControls) boardSession.updateControls();
    refresh();
    if (options.refresh === "always" || options.refresh === "uncertain" && recovery.state().uncertainCommand)
      void boardSession.updateStatus();
  },
});
const wirelessTransport = createWirelessTransport({
  session: boardSession, fetchWithDeadline, markCommandOutcomeUncertain: recovery.markUncertain,
});
const wirelessForm = bindWirelessForm({
  supported: () => Boolean((currentSnapshot?.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS),
  cleanupRequired: () => Boolean(currentSnapshot?.wireless_cleanup_required),
  ready: wirelessReady,
  scan: wirelessTransport.scan,
  test: wirelessTransport.test,
  cancelTest: wirelessTransport.cancelTest,
  changed: refresh,
});
/** @param {string | null} message */
const setSettingsMessage = message => { settingsMessage = message; };
const settings = createSettingsWorkflow({
  getCurrentSnapshot,
  wireless: wirelessForm,
  operationState,
  runCommandLifecycle,
  boardUrl: path => boardSession.boardUrl(path),
  fetchWithDeadline,
  publishCommandResult: recovery.publish,
  markCommandOutcomeUncertain: recovery.markUncertain,
  setMessage: setSettingsMessage,
  changed: refresh,
});
const deviceActions = createDeviceActions({
  getCurrentSnapshot,
  getSelectedBoard: () => boardSession.state().selectedBoard,
  operationState,
  runCommandLifecycle,
  boardUrl: boardSession.boardUrl,
  fetchWithDeadline,
  publishCommandResult: recovery.publish,
  markCommandOutcomeUncertain: recovery.markUncertain,
  uncertainMessage,
  setSettingsMessage,
});

/** @typedef {import("./operation-state.mjs").OperationSnapshot} OperationSnapshot */
/** @param {OperationSnapshot | null} [snapshot] @returns {import("./operation-state.mjs").OperationState} */
function operationState(snapshot = currentSnapshot) {
  const session = boardSession.state();
  const commands = recovery.state();
  return deriveOperationState(snapshot, {
    uncertain: commands.uncertainCommand !== null, rebootPending: commands.rebootPending !== null,
    resyncing: recovery.resyncing(), saving: commandInProgress,
    wirelessBusy: wirelessForm.operationBusy(), wirelessInFlight: wirelessForm.inFlight(),
    statusFailed: session.statusError !== null, scanning: session.scanning,
    radiosDirty: wirelessForm.radioEdited("wifi") || wirelessForm.radioEdited("ble"),
    settingsDirty: settings.dirty(), wirelessDirty: wirelessForm.dirty(),
    wirelessBlockReason: wirelessForm.saveBlockReason(),
  });
}

function wirelessReady() {
  return operationState().canProvisionWireless && !wirelessForm.inFlight();
}

/** @param {DashboardSnapshot} snapshot */
function acceptConnection(snapshot) {
  if (snapshot.connected === true) disconnectedUi = false;
  else if (snapshot.connected === false && !disconnectedUi) {
    disconnectedUi = true;
    wirelessForm.reset();
    settings.clearDraft();
    settingsMessage = null;
  }
}

function settingsEditState() {
  return { settings_dirty: settings.dirty(), settings_draft: settings.selected() };
}

/** @param {DashboardSnapshot} snapshot */
function renderStatus(snapshot) {
  const operations = operationState(snapshot);
  boardSession.updateControls();
  const session = boardSession.state();
  const commands = recovery.state();
  const rebootRecoveryHint = commands.rebootUptimeMs === null
    ? "No pre-reboot uptime was available to confirm a missed restart; reload the dashboard to reconcile with the host."
    : "If the dashboard missed the restart and controls remain disabled, reload it to reconcile with the host.";
  const rebootMessage = commands.rebootPending === "requested" && snapshot.connected === true
    && !snapshot.reboot_pending
    ? `${settingsMessage ?? "Reboot requested. Waiting for the device to reconnect."} ${rebootRecoveryHint}`
    : null;
  renderDashboardStatus({
    ...snapshot,
    error: snapshot.error ?? (commands.uncertainCommand ? snapshot.command_resync_supported
      ? commands.uncertainCommand.message
      : "Command outcome is uncertain. Reconnect the board and reload the dashboard before retrying."
      : commands.commandFailure?.message ?? session.scanWarning),
    no_board_selected: !session.selectedBoard,
    console_url: session.selectedBoard && session.statusError === null ? boardSession.boardUrl("/console") : null,
    ...settingsEditState(),
    wireless_dirty: wirelessForm.dirty(),
    settings_message: rebootMessage ?? settingsMessage ?? snapshot.settings_message,
    status_read_error: session.statusError !== null,
    status_reading: session.statusReading,
  }, operations);
  const discard = /** @type {HTMLButtonElement} */ (element("wireless-discard"));
  discard.hidden = !wirelessForm.conflicted();
  discard.disabled = !operations.canProvisionWireless;
  wirelessForm.update();
}

bindIdentityPreviews();
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
element("led-colour").addEventListener("change", deviceActions.setLed);
element("benchmark-start").addEventListener("click", () => deviceActions.benchmark(true));
element("benchmark-cancel").addEventListener("click", () => deviceActions.benchmark(false));
element("msc-enable").addEventListener("click", () => deviceActions.requestMsc(true));
element("msc-return").addEventListener("click", () => deviceActions.requestMsc(false));
element("cancel-msc").addEventListener("click", () => mscDialog.close());
element("confirm-msc").addEventListener("click", deviceActions.setMsc);
boardSelect.addEventListener("change", () => boardSession.selectBoard(boardSelect.value));
rescanBoardsButton.addEventListener("click", boardSession.rescanBoards);
clockControl.addEventListener("change", () => settings.setClock(clockControl.value));
element("settings-save").addEventListener("click", settings.confirm);
element("confirm-configuration").addEventListener("click", settings.save);
element("cancel-configuration").addEventListener("click", () => configurationDialog.close());
rebootControl.addEventListener("click", () => {
  if (!rebootControl.disabled) deviceActions.confirmReboot(settings.dirty() || wirelessForm.dirty());
});
element("confirm-reboot").addEventListener("click", deviceActions.rebootDevice);
element("cancel-reboot").addEventListener("click", () => rebootDialog.close());
element("command-resync").addEventListener("click", recovery.resync);
element("wifi-resync").addEventListener("click", recovery.resync);
for (const modal of [configurationDialog, rebootDialog, mscDialog]) {
  modal.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      modal.close();
    }
  });
}
void boardSession.rescanBoards();
const pollWhenVisible = () => document.hidden ? Promise.resolve() : boardSession.updateStatus();
document.addEventListener?.("visibilitychange", pollWhenVisible);
window.setInterval(pollWhenVisible, 1000);
