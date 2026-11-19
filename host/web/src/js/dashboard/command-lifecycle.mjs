// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

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
