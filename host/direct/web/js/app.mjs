// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { BoardSession } from "./board/session.mjs";
import { HidTransport } from "./transport/hid.mjs";
import { BleTransport } from "./transport/ble.mjs";
import { createDashboardStore } from "./state/store.mjs";
import { createTimerScope } from "./timers.mjs";
import { mountDashboard } from "./ui/dashboard.mjs";
import { consoleTarget, serveConsoleTarget } from "./ui/console-target.mjs";

const timers = createTimerScope();
const store = createDashboardStore({});
let consoleAvailable = false;
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  try {
    const response = await fetch("/api/console/capabilities", { signal: AbortSignal.timeout(1500) });
    if (response.status !== 404) {
      if (!response.ok || (await response.json())?.available !== true) throw new Error("Invalid console capability response");
      consoleAvailable = true;
    }
  } catch (error) {
    console.error("Local Wi-Fi console relay discovery failed", error);
  }
}
const consoleSource = consoleAvailable ? crypto.randomUUID() : "";
const consoleChannel = consoleAvailable ? new BroadcastChannel(`espforge-console-${consoleSource}`) : null;
if (consoleChannel !== null) serveConsoleTarget(consoleChannel, store.getState);

function createSession(kind) {
  const transport = kind === "ble"
    ? new BleTransport(globalThis.isSecureContext ? navigator.bluetooth : undefined)
    : new HidTransport(globalThis.isSecureContext ? navigator.hid : undefined);
  return new BoardSession(transport, { timerScope: timers, store });
}

/** Browser facts injected into the UI, read live so they match `createSession`; app.mjs is the only global reader. */
const environment = {
  get secure() { return Boolean(globalThis.isSecureContext); },
  get hid() { return Boolean(navigator.hid); },
  get ble() { return Boolean(navigator.bluetooth); },
  get clipboard() { return navigator.clipboard ?? null; },
  now: () => Date.now(),
  consoleUrl(state) {
    const target = consoleAvailable ? consoleTarget(state) : null;
    return target === null ? null : `/console.html?${new URLSearchParams({ source: consoleSource, ...target })}`;
  },
};

let session = createSession("usb");
const dashboard = mountDashboard({
  session, timers, environment,
  selectTransport(kind) {
    session.dispose();
    session = createSession(kind);
    return session;
  },
});
window.addEventListener?.("pagehide", () => {
  dashboard.dispose();
  session.dispose();
  timers.dispose();
  consoleChannel?.close();
}, { once: true });
window.addEventListener?.("pageshow", event => {
  // Cached pages have disposed sessions; reload preserves the journal without resuming stale device state.
  if (event.persisted) location.reload();
});
