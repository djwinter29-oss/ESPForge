// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/**
 * @file Page-owned timer scopes so connection replacement and page teardown cancel scheduled work.
 */
import { REASON } from "./state/errors.mjs";

/** @typedef {ReturnType<typeof globalThis.setTimeout> & {unref?: () => void}} TimerHandle */
/** @typedef {(...args: unknown[]) => void} TimerCallback */
/**
 * @typedef {object} TimeoutTimers
 * @property {(callback: () => void, delay: number) => TimerHandle} setTimeout
 * @property {(handle: TimerHandle | null) => void} clearTimeout
 */
/** @type {TimeoutTimers} */
const DEFAULT_TIMEOUT_TIMERS = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: handle => { if (handle !== null) globalThis.clearTimeout(handle); },
};
/**
 * @typedef {object} TimerScope
 * @property {(callback: TimerCallback, delay: number, ...args: unknown[]) => TimerHandle} setTimeout
 * @property {(callback: TimerCallback, delay: number, ...args: unknown[]) => TimerHandle} setInterval
 * @property {(handle: TimerHandle | null) => void} clearTimeout
 * @property {(handle: TimerHandle) => void} clearInterval
 * @property {() => TimerScope} createChild
 * @property {() => void} dispose
 * @property {(child: TimerScope) => void} removeChild
 */

/** @brief Create a timer scope whose disposal cancels its timers and child scopes; `parent` forgets it then. */
/** @param {TimerScope | null} [parent] */
export function createTimerScope(parent = null) {
  const timeouts = new Set();
  const intervals = new Set();
  const children = new Set();
  let disposed = false;
  /** @type {TimerScope} */
  const scope = {
    /** @return {TimerHandle} Browser timer ID, or an unref-capable handle in host tests. */
    /** @param {TimerCallback} callback @param {number} delay @param {...unknown} args */
    setTimeout(callback, delay, ...args) {
      if (disposed) throw new Error("Timer scope is disposed");
      /** @type {TimerHandle} */
      let handle;
      handle = globalThis.setTimeout(() => {
        timeouts.delete(handle);
        if (!disposed) callback(...args);
      }, delay);
      timeouts.add(handle);
      return handle;
    },
    /** @return {TimerHandle} */
    /** @param {TimerCallback} callback @param {number} delay @param {...unknown} args */
    setInterval(callback, delay, ...args) {
      if (disposed) throw new Error("Timer scope is disposed");
      const handle = globalThis.setInterval(() => {
        if (!disposed) callback(...args);
      }, delay);
      intervals.add(handle);
      return handle;
    },
    /** @param {TimerHandle | null} handle */
    clearTimeout(handle) {
      if (handle === null) return;
      globalThis.clearTimeout(handle);
      timeouts.delete(handle);
    },
    /** @param {TimerHandle} handle */
    clearInterval(handle) {
      globalThis.clearInterval(handle);
      intervals.delete(handle);
    },
    /** @return {TimerScope} */
    createChild() {
      if (disposed) throw new Error("Timer scope is disposed");
      const child = createTimerScope(scope);
      children.add(child);
      return child;
    },
    /** @brief Cancel every owned timer and child scope; idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of timeouts) globalThis.clearTimeout(handle);
      for (const handle of intervals) globalThis.clearInterval(handle);
      timeouts.clear();
      intervals.clear();
      for (const child of children) child.dispose();
      children.clear();
      parent?.removeChild(scope);
    },
    /** @param {TimerScope} child */
    removeChild(child) { children.delete(child); },
  };
  return scope;
}

/**
 * @brief Resolve after `milliseconds`, or reject with the abort reason when `signal` aborts first.
 * @param {number} milliseconds
 * @param {AbortSignal} [signal]
 * @param {TimeoutTimers} [timers]
 * @return {Promise<void>}
 */
export function wait(milliseconds, signal, timers = DEFAULT_TIMEOUT_TIMERS) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new DOMException(REASON.OPERATION_CANCELLED, "AbortError"));
      return;
    }
    const timer = timers.setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      timers.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException(REASON.OPERATION_CANCELLED, "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * @brief Settle with `operation`, or reject with IO_TIMEOUT after `milliseconds` or the abort reason first.
 * The operation itself is not cancelled; a late outcome is ignored, so callers treat a timeout as uncertain.
 * @template Value
 * @param {Value | PromiseLike<Value>} operation
 * @param {number} milliseconds
 * @param {AbortSignal} [signal]
 * @param {TimeoutTimers} [timers]
 * @return {Promise<Value>}
 */
export function withTimeout(operation, milliseconds, signal, timers = DEFAULT_TIMEOUT_TIMERS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      timers.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    /** @param {Value} value */
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    /** @param {unknown} error */
    const finishReject = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => finishReject(signal?.reason ?? new DOMException(REASON.OPERATION_CANCELLED, "AbortError"));
    const timer = timers.setTimeout(() => finishReject(new DOMException(REASON.IO_TIMEOUT, "TimeoutError")),
      milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(finishResolve, finishReject);
  });
}
