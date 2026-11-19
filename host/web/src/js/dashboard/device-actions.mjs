// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { acknowledge, responseJson } from "./api.mjs";

/**
 * @typedef {import("./api.mjs").StatusSnapshot} DashboardSnapshot
 * @typedef {import("./api.mjs").ControlResult} ControlResult
 * @typedef {import("./operation-state.mjs").OperationState} OperationState
 * @typedef {import("./operation-state.mjs").Recovery} Recovery
 * @typedef {import("./command-lifecycle.mjs").CommandLifecycleOptions} CommandLifecycleOptions
 * @typedef {{
 *   getCurrentSnapshot: () => DashboardSnapshot | null,
 *   getSelectedBoard: () => string | null,
 *   operationState: () => OperationState,
 *   runCommandLifecycle: (options: CommandLifecycleOptions, run: () => Promise<unknown>,
 *     failed: (error: Error) => void) => Promise<unknown>,
 *   boardUrl: (path: string, boardId?: string | null) => string,
 *   fetchWithDeadline: (url: string, options: RequestInit, timeoutMs: number) => Promise<Response>,
 *   publishCommandResult: (result: ControlResult) => void,
 *   markCommandOutcomeUncertain: (error: Error, message?: string, recovery?: Recovery, boardId?: string | null) => boolean,
 *   uncertainMessage: (error: Error, fallback: string) => string,
 *   setSettingsMessage: (message: string) => void,
 * }} DeviceActionOptions
 */

/** Owns confirmed device mutations outside the dashboard composition module.
 * @param {DeviceActionOptions} options
 */
export function createDeviceActions({
  getCurrentSnapshot, getSelectedBoard, operationState, runCommandLifecycle, boardUrl, fetchWithDeadline,
  publishCommandResult, markCommandOutcomeUncertain, uncertainMessage, setSettingsMessage,
}) {
  /** @param {string} id */
  const element = id => {
    const node = document.querySelector(`#${id}`);
    if (!node) throw new Error(`Missing dashboard element: ${id}`);
    return /** @type {HTMLElement} */ (node);
  };
  let mscTarget = false;
  /** @type {string | null} */
  let mscBoard = null;

  async function requestReboot() {
    const response = await fetchWithDeadline(boardUrl("/api/reboot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }, 15000);
    publishCommandResult(acknowledge(await responseJson(response,
      `Reboot endpoint returned HTTP ${response.status}`, true), 2));
  }

  async function rebootDevice() {
    const dialog = /** @type {HTMLDialogElement} */ (element("reboot-dialog"));
    if (!dialog.open) return;
    dialog.close();
    const operations = operationState();
    if (!getCurrentSnapshot()?.connected || operations.busy || !operations.canReboot) return;
    await runCommandLifecycle({
      startMessage: "Requesting reboot...",
      clearFailure: 2,
      refresh: "uncertain",
    }, async () => {
      await requestReboot();
      setSettingsMessage("Reboot requested. Waiting for the device to reconnect.");
    }, error => {
      if (markCommandOutcomeUncertain(error)) {
        setSettingsMessage(uncertainMessage(error,
          "Reboot outcome is uncertain; waiting for the board to reconnect before retrying."));
      } else setSettingsMessage(`Reboot failed: ${error.message}`);
    });
  }

  /** @param {boolean} enabled */
  function requestMsc(enabled) {
    const operations = operationState();
    if (!(enabled ? operations.canEnableMsc : operations.canReturnMsc)) return;
    mscTarget = enabled;
    mscBoard = getSelectedBoard();
    element("msc-dialog-title").textContent = enabled ? "Enable USB drive?" : "Return card to firmware?";
    element("msc-warning").textContent = enabled
      ? "Firmware will unmount the card and give Linux/Windows exclusive access. USB reconnects briefly; unsaved dashboard edits may be lost."
      : "Safely eject the USB drive in Linux/Windows first. Confirm only after eject completes; firmware cannot verify the host cache is flushed.";
    element("confirm-msc").textContent = enabled ? "Enable USB drive" : "I have safely ejected";
    /** @type {HTMLDialogElement} */ (element("msc-dialog")).showModal();
  }

  async function setMsc() {
    const dialog = /** @type {HTMLDialogElement} */ (element("msc-dialog"));
    if (!dialog.open || mscBoard !== getSelectedBoard()) return;
    const enabled = mscTarget;
    dialog.close();
    const operations = operationState();
    if (!(enabled ? operations.canEnableMsc : operations.canReturnMsc) || !getCurrentSnapshot()) return;
    const snapshot = getCurrentSnapshot();
    await runCommandLifecycle({
      startMessage: "Requesting storage handoff...",
      updateBoardControls: true,
      refresh: "always",
    }, async () => {
      const response = await fetchWithDeadline(boardUrl("/api/msc"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, confirm_ejected: !enabled }),
      }, 15000);
      publishCommandResult(acknowledge(await responseJson(response, "Storage handoff failed", true), 3));
      if (snapshot) snapshot.storage_stale = true;
      setSettingsMessage("Storage handoff admitted. Waiting for fresh card ownership status.");
    }, error => {
      if (!markCommandOutcomeUncertain(error, undefined, { kind: "resync" }))
        setSettingsMessage(`Storage handoff failed: ${error.message}`);
    });
  }

  /** @param {boolean} start */
  async function benchmark(start) {
    if (!(start ? operationState().canStartBenchmark : operationState().canCancelBenchmark)) return;
    const size = start ? Number(/** @type {HTMLInputElement} */ (element("benchmark-size")).value) : 0;
    if (start && !window.confirm(`Write and verify ${size} MiB in EFTEST.BIN, then delete that file? Back up the card first. This causes card wear.`))
      return;
    const boardId = getSelectedBoard();
    await runCommandLifecycle({ refresh: "always" }, async () => {
      const response = await fetchWithDeadline(boardUrl("/api/benchmark", boardId), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, size_mib: size, confirm: start }),
      }, 15000);
      publishCommandResult(acknowledge(await responseJson(response, "Benchmark request failed", true), 4));
    }, error => {
      if (!markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId))
        setSettingsMessage(`Benchmark request failed: ${error.message}`);
    });
  }

  async function setLed() {
    if (!operationState().canSetLed) return;
    const colour = Number(/** @type {HTMLSelectElement} */ (element("led-colour")).value);
    const boardId = getSelectedBoard();
    const snapshot = getCurrentSnapshot();
    await runCommandLifecycle({ refresh: "always" }, async () => {
      const response = await fetchWithDeadline(boardUrl("/api/led", boardId), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ colour }),
      }, 15000);
      publishCommandResult(acknowledge(await responseJson(response, "LED colour request failed", true), 1));
      if (snapshot) snapshot.telemetry_stale = true;
    }, error => {
      if (!markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId))
        setSettingsMessage(`LED colour request failed: ${error.message}`);
    });
  }

  return { benchmark, rebootDevice, requestMsc, setLed, setMsc };
}
