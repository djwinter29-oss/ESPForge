// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { reconciledResult, responseJson, wirelessConfiguration } from "./api.mjs";
import { hasUnknownOutcome } from "./command-lifecycle.mjs";
import { commandEffects, createCommandState, observeCommandStatus } from "./operation-state.mjs";

/**
 * @typedef {import("./api.mjs").StatusSnapshot} DashboardSnapshot
 * @typedef {import("./api.mjs").ControlResult} ControlResult
 * @typedef {import("./operation-state.mjs").BoardCommandState} BoardCommandState
 * @typedef {import("./operation-state.mjs").OperationState} OperationState
 * @typedef {import("./operation-state.mjs").Recovery} Recovery
 * @typedef {{
 *   session: Pick<ReturnType<typeof import("./board-session.mjs").createBoardSession>,
 *     "boardUrl" | "commandChanged" | "state" | "updateControls" | "updateStatus">,
 *   getCurrentSnapshot: () => DashboardSnapshot | null,
 *   operationState: () => OperationState,
 *   fetchWithDeadline: (url: string, options: RequestInit, timeoutMs: number) => Promise<Response>,
 *   wifiCancelResolved: (completed: boolean, message?: string) => void,
 *   clearWirelessTest: () => Promise<boolean>,
 *   changed: () => void,
 * }} CommandRecoveryOptions
 */

/** Owns per-board command outcomes: failures, pending reboot, uncertain delivery and explicit Re-sync.
 * State survives board switches so an uncertain command on one board still blocks retries when it is reselected.
 * @param {CommandRecoveryOptions} options
 */
export function createCommandRecovery({
  session, getCurrentSnapshot, operationState, fetchWithDeadline, wifiCancelResolved, clearWirelessTest, changed,
}) {
  /** @type {Map<string, BoardCommandState>} */
  const boards = new Map();
  let current = createCommandState();
  let resyncing = false;

  /** @param {string} boardId */
  function stateFor(boardId) {
    let state = boards.get(boardId);
    if (!state) { state = createCommandState(); boards.set(boardId, state); }
    return state;
  }

  /** @param {string | null} boardId */
  function selectBoard(boardId) {
    current = boardId ? stateFor(boardId) : createCommandState();
  }

  /** @param {number} opcode */
  function clearFailure(opcode) {
    if (current.commandFailure?.opcode === opcode) current.commandFailure = null;
  }

  /** Apply the same confirmed lifecycle effects for ordinary acknowledgements and explicit Re-sync.
   * @param {ControlResult} result
   */
  function publish(result) {
    const snapshot = getCurrentSnapshot();
    const effects = commandEffects(result);
    if (effects.reboot) {
      current.rebootPending = "requested";
      const uptime = snapshot?.runtime?.uptime_milliseconds ?? snapshot?.runtime?.uptime_ms;
      current.rebootUptimeMs = typeof uptime === "number" && Number.isFinite(uptime) && uptime >= 0
        ? uptime : null;
    }
    if (effects.wifiCancel) {
      if (effects.completed && snapshot) snapshot.wireless_cleanup_required = false;
      wifiCancelResolved(effects.completed);
    }
    if (effects.failure) current.commandFailure = { opcode: result.opcode, message: effects.failure };
    else clearFailure(result.opcode);
    if (effects.completed && result.opcode === 4 && snapshot) {
      snapshot.storage_stale = true;
      snapshot.self_test_stale = true;
    }
  }

  /** Record an unknown delivery outcome against its originating board; never resend the command.
   * @param {Error} error @param {string} [message] @param {Recovery} [recovery] @param {string | null} [boardId]
   * @returns {boolean} True when the error left the outcome unknown.
   */
  function markUncertain(error, message = "Command outcome is uncertain. Use Re-sync before retrying.",
    recovery = { kind: "reconnect" }, boardId = session.state().selectedBoard) {
    if (!hasUnknownOutcome(error)) return false;
    const command = { ...recovery, message };
    if (boardId !== session.state().selectedBoard) {
      if (boardId) stateFor(boardId).uncertainCommand = command;
      return true;
    }
    current.uncertainCommand = command;
    const snapshot = getCurrentSnapshot();
    if (snapshot) snapshot.error = message;
    return true;
  }

  /** Match fresh status against a pending settings or reboot command; Re-sync owns reconciliation meanwhile.
   * @param {DashboardSnapshot} snapshot
   */
  function observeStatus(snapshot) {
    if (resyncing) return null;
    const rebootWasPending = current.rebootPending !== null;
    const settledCommand = observeCommandStatus(current, snapshot);
    return {
      settledCommand,
      rebootSettled: rebootWasPending && current.rebootPending === null,
    };
  }

  async function resync() {
    const operations = operationState();
    if (!operations.canRecover || !getCurrentSnapshot()) return false;
    const version = session.state().selectionVersion;
    const sameBoard = () => version === session.state().selectionVersion;
    session.commandChanged();
    resyncing = true;
    changed();
    try {
      if (operations.recovery === "cleanup") {
        if (await clearWirelessTest()) await session.updateStatus();
        return false;
      }
      const response = await fetchWithDeadline(session.boardUrl("/api/control/resync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }, 10000);
      const result = await responseJson(response, `Command re-sync returned HTTP ${response.status}`, true);
      const snapshot = getCurrentSnapshot();
      if (!sameBoard() || !snapshot) return false;
      const control = reconciledResult(result);
      current.uncertainCommand = null;
      snapshot.command_outcome_uncertain = false;
      snapshot.error = null;
      if (control) publish(control);
      if (result.temporary_wifi_reset === true) {
        wifiCancelResolved(true, "Board restarted; the temporary Wi-Fi test was discarded. Test again.");
        snapshot.wireless_cleanup_required = false;
      } else if (control?.opcode !== 10) wifiCancelResolved(false);
      if (result.wireless != null) snapshot.wireless = wirelessConfiguration(result.wireless);
      if (result.control_result) snapshot.control_result = result.control_result;
      await session.updateStatus();
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const latest = getCurrentSnapshot();
      if (sameBoard() && latest) latest.error = error.message;
      return false;
    } finally {
      session.commandChanged();
      resyncing = false;
      session.updateControls();
      if (sameBoard()) changed();
    }
  }

  return {
    clearFailure, markUncertain, observeStatus, publish, resync, selectBoard,
    resyncing: () => resyncing,
    state: () => current,
  };
}
