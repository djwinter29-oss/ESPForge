// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { BoardSession } from "./board/session.mjs";
import { BleTransport } from "./transport/ble.mjs";
import { DemoTransport } from "./transport/demo.mjs";
import { SerialTransport } from "./transport/serial.mjs";
import { createDashboardStore } from "./state/store.mjs";
import { createTimerScope } from "./timers.mjs";
import { mountDashboard } from "./ui/dashboard.mjs";

const timers = createTimerScope();
const store = createDashboardStore();

/** @param {import("./transport/transport.mjs").TransportKind} kind */
function createTransport(kind) {
  const secure = globalThis.isSecureContext;
  if (kind === "serial") return new SerialTransport(secure ? navigator.serial : undefined, timers);
  if (kind === "ble") return new BleTransport(secure ? navigator.bluetooth : undefined);
  return new DemoTransport(() => Date.now());
}

/** Browser facts injected into the UI, read live; app.mjs is the only global reader. */
const environment = {
  get secure() { return Boolean(globalThis.isSecureContext); },
  get serial() { return Boolean(navigator.serial); },
  get ble() { return Boolean(navigator.bluetooth); },
  now: () => Date.now(),
  formatTime: (/** @type {number} */ at) => new Date(at).toLocaleTimeString(),
};

const session = new BoardSession({ createTransport, store, timers });
const dashboard = mountDashboard({ session, environment });
window.addEventListener("pagehide", () => {
  dashboard.dispose();
  session.dispose();
  timers.dispose();
}, { once: true });
window.addEventListener("pageshow", event => {
  // Cached pages have disposed sessions; reload instead of resuming stale device state.
  if (event.persisted) location.reload();
});
