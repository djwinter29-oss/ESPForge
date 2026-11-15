// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file Test-progress and temporary credential-expiry timers for wireless form operations.
 */

/**
 * @typedef {Pick<ReturnType<typeof import("../../../timers.mjs").createTimerScope>,
 *   "setInterval" | "clearInterval">} FormTimerScope
 */

/**
 * @brief Own the progress and staged-credential intervals for one wireless form lifecycle.
 * @param {{timers: FormTimerScope, onStageTick: () => void, isExpired: () => boolean, onExpired: () => void}} options
 */
export function createWirelessFormTimers({ timers, onStageTick, isExpired, onExpired }) {
  /** @type {ReturnType<FormTimerScope["setInterval"]> | null} */
  let testTimer = null;
  /** @type {ReturnType<FormTimerScope["setInterval"]> | null} */
  let stagedTimer = null;
  const stopTest = () => {
    timers.clearInterval(testTimer);
    testTimer = null;
  };
  const clearStaged = () => {
    timers.clearInterval(stagedTimer);
    stagedTimer = null;
  };
  return {
    /** @param {() => void} onTick */
    startTest(onTick) {
      stopTest();
      testTimer = timers.setInterval(onTick, 1000);
    },
    stopTest,
    startStaged() {
      clearStaged();
      stagedTimer = timers.setInterval(() => {
        onStageTick();
        if (!isExpired()) return;
        clearStaged();
        onExpired();
      }, 1000);
    },
    clearStaged,
    clear() {
      stopTest();
      clearStaged();
    },
  };
}
