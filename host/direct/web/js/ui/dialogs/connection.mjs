// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file USB and Bluetooth connection dialog handlers.
 */
import { parseHexBytes } from "../../protocol/codec.mjs";
import { queryElement } from "../dom.mjs";
import { UI_TEXT } from "../messages.mjs";
import { boardTargetDescription, captureBoardTarget, runBoardConfirmation } from "./board-confirmation.mjs";

/**
 * @typedef {{getSession: () => import("../../board/session.mjs").BoardSession,
 *   setSession: (session: import("../../board/session.mjs").BoardSession) => void,
 *   selectTransport: (kind: "usb" | "ble") => import("../../board/session.mjs").BoardSession,
 *   hasUnsavedChanges?: () => boolean, reportError?: (message: string) => void,
 *   run: (operation: () => Promise<void>) => void}} ConnectionDialogOptions
 */

/**
 * @brief Bind transport selection, connection, and guarded dialog dismissal.
 * @param {ConnectionDialogOptions} options
 * @return {HTMLDialogElement[]}
 */
export function mountConnectionDialogs({ getSession, setSession, selectTransport, hasUnsavedChanges = () => false,
  reportError = () => {}, run }) {
  /** @param {string} id */
  const element = id => queryElement(`#${id}`);
  /** @param {string} id */
  const button = id => queryElement(`button#${id}`);
  const controlKey = queryElement("input#direct-ble-control-key");
  const dialogs = /** @type {HTMLDialogElement[]} */ ([
    queryElement("dialog#usb-connection-dialog"), queryElement("dialog#bluetooth-connection-dialog"),
    queryElement("dialog#disconnect-dialog"),
  ]);
  let disconnectTarget = null;
  const requestDisconnect = session => {
    disconnectTarget = captureBoardTarget(session);
    element("disconnect-target").textContent = boardTargetDescription(session);
    element("disconnect-warning").textContent = UI_TEXT.unsavedEditsWillBeLost;
    dialogs[2].showModal();
  };
  for (const [id, dialog, bluetooth] of /** @type {[string, HTMLDialogElement, boolean][]} */ (
    [["usb-open", dialogs[0], false], ["bluetooth-open", dialogs[1], true]])) {
    element(id).addEventListener("click", () => {
      if (button(id).disabled) return;
      if ((getSession().state.link === "ble") !== bluetooth) {
        setSession(selectTransport(bluetooth ? "ble" : "usb"));
      }
      dialog.showModal();
    });
  }
  element("usb-connect").addEventListener("click", () => run(async () => {
    const session = getSession();
    if (button("usb-connect").disabled) return;
    if (session.state.connected || session.state.reconnecting) {
      if (session.state.connected && hasUnsavedChanges()) requestDisconnect(session);
      else await session.disconnect();
    } else {
      await session.connect();
      if (session.state.connected) dialogs[0].close();
    }
  }));
  element("bluetooth-scan").addEventListener("click", () => run(async () => {
    const session = getSession();
    if (button("bluetooth-scan").disabled) return;
    if (session.state.connected || session.state.reconnecting) {
      if (session.state.connected && hasUnsavedChanges()) requestDisconnect(session);
      else await session.disconnect();
      return;
    }
    const key = controlKey.value;
    controlKey.value = "";
    await session.connect(parseHexBytes(key, 32, "control-key"));
    if (session.state.connected) dialogs[1].close();
  }));
  element("cancel-disconnect").addEventListener("click", () => {
    disconnectTarget = null;
    dialogs[2].close();
  });
  element("confirm-disconnect").addEventListener("click", () => run(async () => {
    if (!dialogs[2].open) return;
    const target = disconnectTarget;
    disconnectTarget = null;
    dialogs[2].close();
    await runBoardConfirmation(target, getSession, reportError, UI_TEXT.disconnectBoardChanged,
      session => session.disconnect());
  }));
  dialogs[2].addEventListener("close", () => { disconnectTarget = null; });
  for (const [name, dialog] of /** @type {[string, HTMLDialogElement][]} */ (
    [["usb", dialogs[0]], ["bluetooth", dialogs[1]]])) {
    element(`${name}-connection-close`).addEventListener("click", () => {
      if (!getSession().state.busy) dialog.close();
    });
    dialog.addEventListener("cancel", event => {
      if (getSession().state.busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => { controlKey.value = ""; });
  }
  return dialogs;
}
