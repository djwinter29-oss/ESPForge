// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { DashboardError, responseJson, scannedNetworks, testedWireless } from "./api.mjs";

/**
 * @typedef {import("./operation-state.mjs").Recovery} Recovery
 * @typedef {{
 *   session: Pick<ReturnType<typeof import("./board-session.mjs").createBoardSession>,
 *     "boardUrl" | "commandChanged" | "state">,
 *   fetchWithDeadline: (url: string, options: RequestInit, timeoutMs: number) => Promise<Response>,
 *   markCommandOutcomeUncertain: (error: Error, message?: string, recovery?: Recovery,
 *     boardId?: string | null) => boolean,
 * }} WirelessTransportOptions
 */

/** Sends wireless scan, test and cancel requests for the wireless form.
 * Each request fences concurrent status reads and records lost replies against its originating board.
 * @param {WirelessTransportOptions} options
 */
export function createWirelessTransport({ session, fetchWithDeadline, markCommandOutcomeUncertain }) {
  /** @type {((phase: string) => void) | null} */
  let progress = null;

  /** @template T
   * @param {(boardId: string | null) => Promise<T>} run
   * @param {(error: Error) => Error} [failure]
   * @returns {Promise<T>}
   */
  async function request(run, failure = error => error) {
    const boardId = session.state().selectedBoard;
    session.commandChanged();
    try {
      return await run(boardId);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      markCommandOutcomeUncertain(error, undefined, { kind: "resync" }, boardId);
      throw failure(error);
    } finally {
      session.commandChanged();
    }
  }

  const scan = () => request(async boardId => {
    const response = await fetchWithDeadline(session.boardUrl("/api/wireless/scan", boardId),
      { method: "POST" }, 20000);
    return scannedNetworks(await responseJson(response, `Wireless scan returned HTTP ${response.status}`, true));
  });

  /** @param {import("./wireless-policy.mjs").WifiPair & {password: string}} settings
   * @param {(phase: string) => void} onProgress
   */
  async function test(settings, onProgress) {
    const version = session.state().selectionVersion;
    progress = onProgress;
    try {
      return await request(async boardId => {
        const response = await fetchWithDeadline(session.boardUrl("/api/wireless/test", boardId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
        }, 40000);
        const result = await responseJson(response, `Connection test returned HTTP ${response.status}`, true);
        return testedWireless(result.test);
      }, error => error instanceof TypeError || ["TimeoutError", "AbortError"].includes(error.name)
        ? new Error(error.name === "TimeoutError"
          ? "Wi-Fi test timed out; result is uncertain. Use Re-sync before retrying."
          : "Wi-Fi test result was lost. Use Re-sync before retrying.")
        : error);
    } finally {
      if (version === session.state().selectionVersion) progress = null;
    }
  }

  const cancelTest = () => request(async boardId => {
    const response = await fetchWithDeadline(session.boardUrl("/api/wireless/cancel", boardId),
      { method: "POST" }, 10000);
    const result = await responseJson(response, `Cancel returned HTTP ${response.status}`, true);
    if (result.cancelled !== true)
      throw new DashboardError("Invalid wireless cancellation response; outcome is uncertain", undefined, true);
    return result;
  });

  /** Forward a firmware test phase from status polling to the active test, if any.
   * @param {string} phase
   */
  const reportPhase = phase => progress?.(phase);

  return { cancelTest, reportPhase, scan, test };
}
