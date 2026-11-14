// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { initializeSettings, normalizeStatus, renderStatus as renderDashboardStatus } from "./dashboard.mjs";
import { bindWirelessForm } from "./wireless-form.mjs";
import {
  acknowledge, DashboardError, reconciledResult, responseJson, savedSettings, savedWireless,
  scannedBoards, scannedNetworks, statusResponse, testedWireless,
  wirelessConfiguration,
} from "./dashboard-api.mjs";
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
let mscTarget = false;
/** @type {string | null} */
let mscBoard = null;
/** @type {string | null} */
let configurationIdentity = null;
const clockControl = /** @type {HTMLSelectElement} */ (document.querySelector("#settings-clock"));
const rebootControl = /** @type {HTMLButtonElement} */ (document.querySelector("#reboot-control"));
const identityDetails = ["product-information", "module-memory"]
  .map(id => /** @type {HTMLDetailsElement} */ (element(id)));
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
let requestInProgress = false;
/** @typedef {import("./dashboard-api.mjs").StatusSnapshot} DashboardSnapshot
 * @typedef {{id: string, serial_number?: string | null, device_path: string}} Board
 */
/** @type {DashboardSnapshot | null} */
let currentSnapshot = null;
let disconnectedUi = false;
let commandResyncInProgress = false;
let settingsRequestInProgress = false;
/** @type {Partial<Pick<import("./dashboard-api.mjs").BootSettings, "system_clock_mhz">>} */
let settingsDraft = {};
/** @type {string | null} */
let settingsMessage = null;
/** @type {string | null} */
let selectedBoard = null;
let selectedBoardLabel = "";
/** @type {Board[]} */
let knownBoards = [];
let scanningBoards = false;
/** @type {string | null} */
let boardScanWarning = null;
let unknownBoardRescanAt = 0;
// Selection fences board ownership; command versions reject observations started before a local transition.
let selectionVersion = 0;
let commandVersion = 0;
/** @type {((phase: string) => void) | null} */
let wirelessProgress = null;
/** @type {string | null} */
let statusReadError = null;
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
  "Command outcome is uncertain. Use Re-sync before retrying.", recovery = { kind: "reconnect" }, boardId = selectedBoard) {
  if (!hasUnknownOutcome(error)) return false;
  const command = { ...recovery, message };
  if (boardId !== selectedBoard) {
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
    statusFailed: statusReadError !== null, scanning: scanningBoards,
    radiosDirty: wirelessForm.radioEdited("wifi") || wirelessForm.radioEdited("ble"),
    settingsDirty: settingsDirty(), wirelessDirty: wirelessForm.dirty(),
    wirelessBlockReason: wirelessForm.saveBlockReason(),
  });
}

/** Apply the same confirmed lifecycle effects for ordinary acknowledgements and explicit Re-sync.
 * @param {import("./dashboard-api.mjs").ControlResult} result
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
const wirelessForm = bindWirelessForm({
  supported: () => Boolean((currentSnapshot?.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS),
  cleanupRequired: () => Boolean(currentSnapshot?.wireless_cleanup_required),
  ready: wirelessReady,
  scan: async () => {
    const boardId = selectedBoard;
    commandVersion++;
    try {
      const response = await fetchWithDeadline(boardUrl("/api/wireless/scan", boardId), { method: "POST" }, 20000);
      const result = await responseJson(response, `Wireless scan returned HTTP ${response.status}`, true);
      return scannedNetworks(result);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId);
      throw error;
    } finally {
      commandVersion++;
    }
  },
  test: async (settings, onProgress) => {
    const version = selectionVersion;
    const boardId = selectedBoard;
    commandVersion++;
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
      commandVersion++;
      if (version === selectionVersion) wirelessProgress = null;
    }
  },
  cancelTest: async () => {
    const boardId = selectedBoard;
    commandVersion++;
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
      commandVersion++;
    }
  },
  changed: () => { if (currentSnapshot) renderStatus(currentSnapshot); },
});

function wirelessReady() {
  return operationState().canProvisionWireless && !wirelessForm.inFlight();
}

/** Save board settings and credentials in one firmware commit; failures before delivery stay retryable.
 * @param {import("./dashboard-api.mjs").BootSettings} settings
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
function boardUrl(path, boardId = selectedBoard) {
  if (!boardId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}board=${encodeURIComponent(boardId)}`;
}

/** @param {Board} board */
function boardLabel(board) {
  return board.serial_number ? `ESPForge / ${board.serial_number}` : `ESPForge / HID ${board.device_path}`;
}

function boardSelectionBusy() {
  return operationState().boardSelectionBusy;
}

/** @param {OperationState} [operations] */
function updateBoardSelectionControls(operations = operationState()) {
  boardSelect.disabled = operations.boardSelectionBusy || knownBoards.length === 0;
  rescanBoardsButton.disabled = operations.boardSelectionBusy;
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
  updateBoardSelectionControls(operations);
  renderDashboardStatus({
    ...snapshot,
    error: snapshot.error ?? (boardState.uncertainCommand ? snapshot.command_resync_supported
      ? boardState.uncertainCommand.message
        : "Command outcome is uncertain. Reconnect the board and reload the dashboard before retrying."
      : boardState.commandFailure?.message ?? boardScanWarning),
    no_board_selected: !selectedBoard,
    console_url: selectedBoard && statusReadError === null ? boardUrl("/console") : null,
    ...settingsEditState(),
    wireless_dirty: wirelessForm.dirty(),
    settings_message: settingsMessage ?? snapshot.settings_message,
    status_read_error: statusReadError !== null,
    status_reading: requestInProgress,
  }, operations);
  const discard = /** @type {HTMLButtonElement} */ (element("wireless-discard"));
  discard.hidden = !wirelessForm.conflicted();
  discard.disabled = !operations.canProvisionWireless;
  wirelessForm.update();
}

element("wireless-discard").addEventListener("click", async () => {
  if (!operationState().canProvisionWireless || !wirelessForm.conflicted()) return;
  commandVersion++;
  try {
    if (!await wirelessForm.discardEdits() || !currentSnapshot) return;
    currentSnapshot.wireless = null;
    renderStatus(currentSnapshot);
  } finally {
    commandVersion++;
    await updateStatus();
  }
});

async function resyncCommandOutcome() {
  const operations = operationState();
  if (!operations.canRecover || !currentSnapshot) return;
  const version = selectionVersion;
  commandVersion++;
  commandResyncInProgress = true;
  renderStatus(currentSnapshot);
  try {
    if (operations.recovery === "cleanup") {
      if (await wirelessForm.clearTest()) await updateStatus();
      return;
    }
    const response = await fetchWithDeadline(boardUrl("/api/control/resync"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }, 10000);
    const result = await responseJson(response, `Command re-sync returned HTTP ${response.status}`, true);
    if (version !== selectionVersion) return;
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
    await updateStatus();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (version === selectionVersion && currentSnapshot) currentSnapshot.error = error.message;
  } finally {
    commandVersion++;
    commandResyncInProgress = false;
    updateBoardSelectionControls();
    if (version === selectionVersion && currentSnapshot) renderStatus(currentSnapshot);
  }
}

async function updateStatus() {
  if (requestInProgress || settingsRequestInProgress) return;
  requestInProgress = true;
  const version = selectionVersion;
  const command = commandVersion;
  try {
    const response = await fetchWithDeadline(boardUrl("/api/status"), { cache: "no-store" }, 5000);
    /** @type {DashboardSnapshot} */
    const snapshot = normalizeStatus(statusResponse(
      await responseJson(response, `Status endpoint returned HTTP ${response.status}`)));
    if (version !== selectionVersion || command !== commandVersion) return;
    if (settingsRequestInProgress) return;
    statusReadError = null;
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
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (version !== selectionVersion || command !== commandVersion) return;
    // Both hosts return 404 for an unknown board; a restart requires discovery to register it again.
    if (error instanceof DashboardError && error.status === 404
      && Date.now() - unknownBoardRescanAt >= 5000) {
      unknownBoardRescanAt = Date.now();
      void rescanBoards();
    }
    statusReadError = error.message;
    const failedSnapshot = currentSnapshot?.connected
      ? { ...currentSnapshot, error: `Status unavailable: ${error.message}`,
        telemetry_stale: true, storage_stale: true }
      : { connected: false, error: error.message };
    renderStatus(failedSnapshot);
  } finally {
    requestInProgress = false;
    updateBoardSelectionControls();
    if (version !== selectionVersion || command !== commandVersion) void updateStatus();
  }
}

/** @param {string} boardId */
function selectBoard(boardId) {
  if (boardSelectionBusy()) {
    boardSelect.value = selectedBoard || "";
    return;
  }
  const nextBoard = boardId || null;
  if (nextBoard === selectedBoard) return;
  configurationDialog.close();
  rebootDialog.close();
  mscDialog.close();
  selectedBoard = nextBoard;
  const selected = knownBoards.find(board => board.id === selectedBoard);
  selectedBoardLabel = selected ? boardLabel(selected) : selectedBoardLabel;
  selectionVersion++;
  disconnectedUi = false;
  currentSnapshot = null;
  acceptConnection({ connected: false });
  settingsDraft = {};
  settingsMessage = null;
  boardState = selectedBoard ? commandStateFor(selectedBoard) : createCommandState();
  renderStatus({ connected: false });
  void updateStatus();
}

async function rescanBoards() {
  if (boardSelectionBusy()) return;
  scanningBoards = true;
  updateBoardSelectionControls();
  try {
    const response = await fetchWithDeadline("/api/boards", { cache: "no-store" }, 10000);
    const result = await responseJson(response, `Board scan returned HTTP ${response.status}`);
    boardScanWarning = Array.isArray(result.warnings) ? result.warnings.join(" ") || null : null;
    const previousBoard = selectedBoard;
    knownBoards = scannedBoards(result);
    boardSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = knownBoards.length ? "Select a board" : "No boards found";
    boardSelect.append(placeholder);
    for (const board of knownBoards) {
      const option = document.createElement("option");
      option.value = board.id;
      option.textContent = boardLabel(board);
      boardSelect.append(option);
    }
    if (!selectedBoard && typeof result.default_board_id === "string") {
      selectedBoard = result.default_board_id;
    }
    const selected = knownBoards.find(board => board.id === selectedBoard);
    if (selected) {
      selectedBoardLabel = boardLabel(selected);
    } else if (selectedBoard) {
      const missing = document.createElement("option");
      missing.value = selectedBoard;
      missing.textContent = `${selectedBoardLabel || selectedBoard} (not found)`;
      boardSelect.append(missing);
    }
    boardSelect.value = selectedBoard || "";
    if (previousBoard !== selectedBoard) {
      selectionVersion++;
      disconnectedUi = false;
      currentSnapshot = null;
      acceptConnection({ connected: false });
      settingsDraft = {};
      boardState = selectedBoard ? commandStateFor(selectedBoard) : createCommandState();
      renderStatus({ connected: false });
    }
    await updateStatus();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const message = `Board scan failed: ${error.message}`;
    if (currentSnapshot?.connected) {
      currentSnapshot = { ...currentSnapshot, error: message };
      renderStatus(currentSnapshot);
    } else {
      renderStatus({ connected: false, error: message });
    }
  } finally {
    scanningBoards = false;
    updateBoardSelectionControls();
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
  if (confirmedIdentity !== saveIdentity()) {
    settingsMessage = "The proposed configuration changed. Review the settings and confirm again.";
    renderStatus(currentSnapshot);
    return;
  }
  const combined = wirelessForm.dirty();
  commandVersion++;
  settingsRequestInProgress = true;
  clearCommandFailure(5);
  settingsMessage = "Saving boot settings...";
  const settings = selectedSettings();
  renderStatus(currentSnapshot);
  try {
    if (combined) {
      currentSnapshot.settings = await saveCombinedSettings(settings);
      settingsDraft = {};
      settingsMessage = "Settings saved. Reboot requested. Waiting for the device to reconnect.";
      return;
    }
    const response = await fetchWithDeadline(boardUrl("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }, 15000);
    const result = await responseJson(response, `Settings endpoint returned HTTP ${response.status}`, true);
    publishCommandResult({ opcode: 5, status: "completed" });
    currentSnapshot.settings = savedSettings(result, settings);
    currentSnapshot.settings_supported = true;
    settingsDraft = {};
    settingsMessage = "Settings saved. Reboot requested. Waiting for the device to reconnect.";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (markCommandOutcomeUncertain(error, undefined,
      combined ? { kind: "resync" } : { kind: "settings", expected: settings })) {
      settingsMessage = combined
        ? "Wireless save outcome is uncertain; use Re-sync before retrying."
        : "Save outcome is uncertain; checking status before allowing another save.";
    } else settingsMessage = `Save failed: ${error.message}`;
  } finally {
    commandVersion++;
    settingsRequestInProgress = false;
    updateBoardSelectionControls();
    if (currentSnapshot) renderStatus(currentSnapshot);
    if (boardState.uncertainCommand) void updateStatus();
  }
}

async function requestReboot() {
  const response = await fetchWithDeadline(boardUrl("/api/reboot"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  }, 15000);
  publishCommandResult(acknowledge(await responseJson(response, `Reboot endpoint returned HTTP ${response.status}`, true), 2));
}

async function rebootDevice() {
  if (!rebootDialog.open) return;
  rebootDialog.close();
  const operations = operationState();
  if (!currentSnapshot?.connected || operations.busy || !operations.canReboot) return;
  commandVersion++;
  settingsRequestInProgress = true;
  clearCommandFailure(2);
  settingsMessage = "Requesting reboot...";
  renderStatus(currentSnapshot);
  try {
    await requestReboot();
    settingsMessage = "Reboot requested. Waiting for the device to reconnect.";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (markCommandOutcomeUncertain(error)) {
      settingsMessage = uncertainMessage(error,
        "Reboot outcome is uncertain; waiting for the board to reconnect before retrying.");
    } else settingsMessage = `Reboot failed: ${error.message}`;
  } finally {
    commandVersion++;
    settingsRequestInProgress = false;
    if (currentSnapshot) renderStatus(currentSnapshot);
    if (boardState.uncertainCommand) void updateStatus();
  }
}

/** @param {boolean} enabled */
function requestMsc(enabled) {
  const operations = operationState();
  if (!(enabled ? operations.canEnableMsc : operations.canReturnMsc)) return;
  mscTarget = enabled;
  mscBoard = selectedBoard;
  element("msc-dialog-title").textContent = enabled ? "Enable USB drive?" : "Return card to firmware?";
  element("msc-warning").textContent = enabled
    ? "Firmware will unmount the card and give Linux/Windows exclusive access. USB reconnects briefly; unsaved dashboard edits may be lost."
    : "Safely eject the USB drive in Linux/Windows first. Confirm only after eject completes; firmware cannot verify the host cache is flushed.";
  element("confirm-msc").textContent = enabled ? "Enable USB drive" : "I have safely ejected";
  mscDialog.showModal();
}

async function setMsc() {
  if (!mscDialog.open || mscBoard !== selectedBoard) return;
  const enabled = mscTarget;
  mscDialog.close();
  const operations = operationState();
  if (!(enabled ? operations.canEnableMsc : operations.canReturnMsc) || !currentSnapshot) return;
  commandVersion++;
  settingsRequestInProgress = true;
  settingsMessage = "Requesting storage handoff...";
  renderStatus(currentSnapshot);
  try {
    const response = await fetchWithDeadline(boardUrl("/api/msc"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, confirm_ejected: !enabled }),
    }, 15000);
    publishCommandResult(acknowledge(await responseJson(response, "Storage handoff failed", true), 3));
    currentSnapshot.storage_stale = true;
    settingsMessage = "Storage handoff admitted. Waiting for fresh card ownership status.";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!markCommandOutcomeUncertain(error, undefined, { kind: "resync" }))
      settingsMessage = `Storage handoff failed: ${error.message}`;
  } finally {
    commandVersion++;
    settingsRequestInProgress = false;
    updateBoardSelectionControls();
    if (currentSnapshot) renderStatus(currentSnapshot);
    void updateStatus();
  }
}

/** @param {boolean} start */
async function benchmark(start) {
  if (!(start ? operationState().canStartBenchmark : operationState().canCancelBenchmark)) return;
  const size = start ? Number(/** @type {HTMLInputElement} */ (element("benchmark-size")).value) : 0;
  if (start && !window.confirm(`Write and verify ${size} MiB in EFTEST.BIN, then delete that file? Back up the card first. This causes card wear.`))
    return;
  const boardId = selectedBoard;
  commandVersion++;
  settingsRequestInProgress = true;
  if (currentSnapshot) renderStatus(currentSnapshot);
  try {
    const response = await fetchWithDeadline(boardUrl("/api/benchmark", boardId), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start, size_mib: size, confirm: start }),
    }, 15000);
    publishCommandResult(acknowledge(await responseJson(response, "Benchmark request failed", true), 4));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId))
      settingsMessage = `Benchmark request failed: ${error.message}`;
  } finally {
    commandVersion++;
    settingsRequestInProgress = false;
    if (currentSnapshot) renderStatus(currentSnapshot);
    void updateStatus();
  }
}
element("led-colour").addEventListener("change", async () => {
  if (!operationState().canSetLed) return;
  const colour = Number(/** @type {HTMLSelectElement} */ (element("led-colour")).value);
  const boardId = selectedBoard;
  commandVersion++;
  settingsRequestInProgress = true;
  if (currentSnapshot) renderStatus(currentSnapshot);
  try {
    const response = await fetchWithDeadline(boardUrl("/api/led", boardId), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ colour }),
    }, 15000);
    publishCommandResult(acknowledge(await responseJson(response, "LED colour request failed", true), 1));
    if (currentSnapshot) currentSnapshot.telemetry_stale = true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId))
      settingsMessage = `LED colour request failed: ${error.message}`;
  } finally {
    commandVersion++;
    settingsRequestInProgress = false;
    if (currentSnapshot) renderStatus(currentSnapshot);
    void updateStatus();
  }
});
element("benchmark-start").addEventListener("click", () => benchmark(true));
element("benchmark-cancel").addEventListener("click", () => benchmark(false));
element("msc-enable").addEventListener("click", () => requestMsc(true));
element("msc-return").addEventListener("click", () => requestMsc(false));
element("cancel-msc").addEventListener("click", () => mscDialog.close());
element("confirm-msc").addEventListener("click", setMsc);
boardSelect.addEventListener("change", () => selectBoard(boardSelect.value));
rescanBoardsButton.addEventListener("click", rescanBoards);
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
element("confirm-reboot").addEventListener("click", rebootDevice);
void rescanBoards();
const pollWhenVisible = () => {
  return document.hidden ? Promise.resolve() : updateStatus();
};
document.addEventListener?.("visibilitychange", pollWhenVisible);
window.setInterval(pollWhenVisible, 1000);