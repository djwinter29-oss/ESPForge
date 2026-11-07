// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Wi-Fi dialog: submit credentials once over USB-UART; the passphrase never stays in the form. */

import { queryElement, setStatus } from "../dom.mjs";
import { MESSAGES } from "../messages.mjs";
import { selectControls } from "../../state/selectors.mjs";

/**
 * @param {{ session: import("../../board/session.mjs").BoardSession, root: Document, signal: AbortSignal }} options
 */
export function mountWirelessForm({ session, root, signal }) {
  const store = session.store;
  const open = queryElement("button#wifi-open", root);
  const dialog = queryElement("dialog#wifi-dialog", root);
  const form = queryElement("form#wifi-form", root);
  const ssid = queryElement("input#wifi-ssid", root);
  const password = queryElement("input#wifi-password", root);
  const status = queryElement("p#wifi-status", root);
  const submit = queryElement("button#wifi-connect", root);
  const cancel = queryElement("button#wifi-cancel", root);
  let submitting = false;

  const close = () => {
    password.value = "";
    if (dialog.open) dialog.close();
  };

  open.addEventListener("click", () => {
    setStatus(status, "");
    password.value = "";
    if (!dialog.open) dialog.showModal();
    ssid.focus();
  }, { signal });
  cancel.addEventListener("click", close, { signal });
  dialog.addEventListener("close", () => { password.value = ""; }, { signal });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    submit.disabled = true;
    setStatus(status, MESSAGES.submitting);
    try {
      const result = await session.connectWifi({ ssid: ssid.value, psk: password.value });
      setStatus(status, result.message, !result.ok);
      if (result.ok) close();
    } finally {
      password.value = "";
      submitting = false;
      submit.disabled = !selectControls(store.getState()).wifi;
    }
  }, { signal });

  /** @param {import("../../state/reducer.mjs").DashboardState} state */
  return function render(state) {
    const controls = selectControls(state);
    open.disabled = !controls.wifi;
    if (!submitting) submit.disabled = !controls.wifi;
    if (dialog.open && !submitting && state.link !== "connected") {
      setStatus(status, MESSAGES.linkLost, true);
      close();
    }
  };
}
