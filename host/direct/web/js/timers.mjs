// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Owned timer scope so every scheduled callback is cancelled when the page is disposed. */

/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => number,
 *   clearTimeout: (id: number | undefined) => void,
 *   dispose: () => void,
 * }} TimerScope
 * @typedef {{ setTimeout: (callback: () => void, delay: number) => unknown, clearTimeout: (id: any) => void }} Clock
 */

/**
 * @param {Clock} [clock]
 * @return {TimerScope}
 */
export function createTimerScope(clock = globalThis) {
  /** @type {Map<number, unknown>} */
  const pending = new Map();
  let next = 0;
  let disposed = false;
  return {
    setTimeout(callback, delay) {
      if (disposed) throw new Error("Timer scope disposed");
      const id = ++next;
      pending.set(id, clock.setTimeout(() => {
        pending.delete(id);
        callback();
      }, delay));
      return id;
    },
    clearTimeout(id) {
      if (id === undefined || !pending.has(id)) return;
      clock.clearTimeout(pending.get(id));
      pending.delete(id);
    },
    dispose() {
      disposed = true;
      for (const handle of pending.values()) clock.clearTimeout(handle);
      pending.clear();
    },
  };
}
