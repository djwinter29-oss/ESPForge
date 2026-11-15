// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { consoleTarget, serveConsoleTarget } from "./console-target.mjs";

/**
 * @typedef {object} ConsoleBootstrapOptions
 * @property {boolean} localServer
 * @property {() => Promise<Response>} fetchCapabilities
 * @property {(name: string) => BroadcastChannel} createChannel
 * @property {() => string} createSource
 * @property {() => import("../../state/reducer.mjs").DashboardState} getState
 *
 * @typedef {{start: () => Promise<boolean>, consoleUrl:
 *   (state: import("../../state/reducer.mjs").DashboardState) => string | null, dispose: () => void}}
 *   ConsoleBootstrap
 */

/**
 * @brief Own optional local-console discovery, same-tab target checks and page-lifetime channel cleanup.
 * @param {ConsoleBootstrapOptions} options
 * @return {ConsoleBootstrap}
 */
export function createConsoleBootstrap({ localServer, fetchCapabilities, createChannel, createSource, getState }) {
  let disposed = false;
  let channel = null;
  let source = "";
  return {
    async start() {
      if (!localServer || disposed) return false;
      const response = await fetchCapabilities();
      if (response.status === 404) return false;
      if (!response.ok || (await response.json())?.available !== true) {
        throw new Error("Invalid console capability response");
      }
      if (disposed) return false;
      source = createSource();
      channel = createChannel(`espforge-console-${source}`);
      serveConsoleTarget(channel, getState);
      return true;
    },
    consoleUrl(state) {
      const target = channel ? consoleTarget(state) : null;
      return target === null ? null : `/console.html?${new URLSearchParams({ source, ...target })}`;
    },
    dispose() {
      disposed = true;
      channel?.close();
      channel = null;
    },
  };
}
