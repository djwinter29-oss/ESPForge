// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Single-flight telemetry poller: the next sample is scheduled only after the previous one settles. */

/**
 * @param {{ timers: import("../timers.mjs").TimerScope, interval: number, task: () => Promise<void> }} options
 */
export function createPoller({ timers, interval, task }) {
  /** @type {number | undefined} */
  let timer;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  let running = false;

  const schedule = () => {
    timers.clearTimeout(timer);
    timer = running ? timers.setTimeout(() => { void run(); }, interval) : undefined;
  };

  function run() {
    timers.clearTimeout(timer);
    timer = undefined;
    if (!running) return Promise.resolve();
    if (inFlight) return inFlight;
    const current = (async () => {
      try {
        await task();
      } finally {
        inFlight = null;
        schedule();
      }
    })();
    inFlight = current;
    return current;
  }

  return {
    get running() { return running; },
    start() {
      running = true;
      return run();
    },
    stop() {
      running = false;
      timers.clearTimeout(timer);
      timer = undefined;
    },
    trigger: run,
  };
}
