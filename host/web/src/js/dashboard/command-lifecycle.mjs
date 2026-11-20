// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { DashboardError } from "./api.mjs";

/**
 * @typedef {{
 *   startMessage?: string,
 *   clearFailure?: number,
 *   updateBoardControls?: boolean,
 *   refresh?: "always" | "uncertain" | "never",
 * }} CommandLifecycleOptions
 */

/** @template T
 * @param {{
 *   begin: (options: CommandLifecycleOptions) => void,
 *   finish: (options: CommandLifecycleOptions) => void,
 * }} lifecycle
 * @returns {(options: CommandLifecycleOptions, run: () => Promise<T>,
 *   failed: (error: Error) => void) => Promise<T | undefined>}
 */
export function createCommandLifecycle({ begin, finish }) {
  return async (options, run, failed) => {
    begin(options);
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed(error);
    } finally {
      finish(options);
    }
  };
}

/** True when a request may have reached the board but its reply was lost.
 * @param {unknown} error
 */
export function hasUnknownOutcome(error) {
  return error instanceof Error && ["AbortError", "TimeoutError", "UnknownOutcomeError"].includes(error.name)
    || error instanceof TypeError;
}

/** True when the host reported that a command outcome is uncertain.
 * @param {unknown} error
 */
export function isUncertainOutcome(error) {
  if (error instanceof DashboardError && typeof error.uncertain === "boolean") return error.uncertain;
  return error instanceof Error && /uncertain|outcome.*not resent/i.test(error.message);
}

/** Prefer the host's uncertainty explanation over a generic recovery message.
 * @param {Error} error @param {string} fallback
 */
export function uncertainMessage(error, fallback) {
  return isUncertainOutcome(error) && /uncertain|outcome.*not resent/i.test(error?.message ?? "")
    ? error.message : fallback;
}
