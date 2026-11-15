// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/** @file Dashboard page entry: composes the transports, board session and dashboard, and serves console checks. */
import { BoardSession } from "./board/session.mjs";
import { HidTransport } from "./transport/hid.mjs";
import { BleTransport } from "./transport/ble.mjs";
import { createDashboardStore } from "./state/store.mjs";
import { createTimerScope } from "./timers.mjs";
import { mountDashboard } from "./ui/dashboard.mjs";
import { consoleTarget, serveConsoleTarget } from "./ui/console/console-target.mjs";

const timers = createTimerScope();
const store = createDashboardStore({});
/** @return {Navigator & {hid?: unknown, bluetooth?: unknown}} */
const deviceNavigator = () => /** @type {Navigator & {hid?: unknown, bluetooth?: unknown}} */ (navigator);
let consoleAvailable = false;
let consoleSource = "";
/** @type {BroadcastChannel | null} */
let consoleChannel = null;
let disposed = false;

/** @param {"usb" | "ble"} kind */
function createSession(kind) {
  const transport = kind === "ble"
    ? new BleTransport(globalThis.isSecureContext ? deviceNavigator().bluetooth : undefined)
    : new HidTransport(globalThis.isSecureContext ? deviceNavigator().hid : undefined);
  return new BoardSession(transport, { timerScope: timers, store });
}

/** Browser facts injected into the UI, read live so they match `createSession`; app.mjs is the only global reader. */
const environment = {
  get secure() { return Boolean(globalThis.isSecureContext); },
  get hid() { return Boolean(deviceNavigator().hid); },
  get ble() { return Boolean(deviceNavigator().bluetooth); },
  get clipboard() { return navigator.clipboard ?? null; },
  now: () => Date.now(),
  /** @param {import("./state/reducer.mjs").DashboardState} state */
  consoleUrl(state) {
    const target = consoleAvailable ? consoleTarget(state) : null;
    return target === null ? null : `/console.html?${new URLSearchParams({ source: consoleSource, ...target })}`;
  },
};

let session = createSession("usb");
const dashboard = mountDashboard({
  session, timers, environment,
  /** @param {"usb" | "ble"} kind */
  selectTransport(kind) {
    session.dispose();
    session = createSession(kind);
    return session;
  },
});
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  void (async () => {
    try {
      const response = await fetch("/api/console/capabilities", { signal: AbortSignal.timeout(1500) });
      if (response.status === 404) return;
      if (!response.ok || (await response.json())?.available !== true) {
        throw new Error("Invalid console capability response");
      }
      if (disposed) return;
      consoleSource = crypto.randomUUID();
      consoleChannel = new BroadcastChannel(`espforge-console-${consoleSource}`);
      serveConsoleTarget(consoleChannel, store.getState);
      consoleAvailable = true;
      dashboard.refresh();
    } catch (error) {
      if (!disposed) console.error("Local Wi-Fi console relay discovery failed", error);
    }
  })();
}
window.addEventListener?.("pagehide", () => {
  disposed = true;
  dashboard.dispose();
  session.dispose();
  timers.dispose();
  consoleChannel?.close();
}, { once: true });
window.addEventListener?.("pageshow", event => {
  // Cached pages have disposed sessions; reload preserves the journal without resuming stale device state.
  if (event.persisted) location.reload();
});
