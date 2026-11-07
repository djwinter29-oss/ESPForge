// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Connection controls: USB and Bluetooth dialogs, simulated preview and disconnect. */

import { queryElement, setStatus } from "../dom.mjs";
import { MESSAGES } from "../messages.mjs";
import { selectControls, selectStatusLine } from "../../state/selectors.mjs";

/**
 * @typedef {{ secure: boolean, serial: boolean, ble: boolean, now: () => number,
 *   formatTime: (at: number) => string }} Environment
 */

/**
 * @param {{ session: import("../../board/session.mjs").BoardSession, environment: Environment, root: Document,
 *   signal: AbortSignal }} options
 */
export function mountControls({ session, environment, root, signal }) {
  const store = session.store;
  const links = [
    { kind: /** @type {const} */ ("serial"), name: "usb", action: "usb-connect",
      available: () => environment.secure && environment.serial, unavailable: MESSAGES.serialUnavailable },
    { kind: /** @type {const} */ ("ble"), name: "bluetooth", action: "bluetooth-scan",
      available: () => environment.secure && environment.ble, unavailable: MESSAGES.bleUnavailable },
  ].map(link => ({
    ...link,
    dialog: queryElement(`dialog#${link.name}-connection-dialog`, root),
    status: queryElement(`p#${link.name}-connection-status`, root),
    open: queryElement(`button#${link.name}-open`, root),
    connect: queryElement(`button#${link.action}`, root),
    close: queryElement(`button#${link.name}-connection-close`, root),
  }));
  const preview = queryElement("button#preview-start", root);
  const disconnect = queryElement("button#disconnect", root);

  for (const link of links) {
    link.open.addEventListener("click", () => {
      const available = link.available();
      setStatus(link.status, available ? "" : link.unavailable, !available);
      link.connect.disabled = !available || !selectControls(store.getState()).connect;
      if (!link.dialog.open) link.dialog.showModal();
    }, { signal });
    link.close.addEventListener("click", () => link.dialog.close(), { signal });
    link.connect.addEventListener("click", async () => {
      if (!link.available()) return;
      link.connect.disabled = true;
      setStatus(link.status, MESSAGES.picker);
      await session.connect(link.kind);
      const state = store.getState();
      if (state.link === "connected") {
        setStatus(link.status, "");
        link.dialog.close();
      } else {
        const line = selectStatusLine(state);
        setStatus(link.status, line.message, line.error);
        link.connect.disabled = !selectControls(state).connect;
      }
    }, { signal });
  }
  preview.addEventListener("click", () => { void session.connect("demo"); }, { signal });
  disconnect.addEventListener("click", () => { void session.disconnect(); }, { signal });

  /** @param {import("../../state/reducer.mjs").DashboardState} state */
  return function render(state) {
    const controls = selectControls(state);
    for (const link of links) {
      link.open.disabled = !controls.connect;
      if (!link.dialog.open) continue;
      if (state.link === "connecting") link.connect.disabled = true;
      else if (!controls.connect) link.dialog.close();
    }
    preview.disabled = !controls.connect;
    disconnect.disabled = !controls.disconnect;
  };
}
