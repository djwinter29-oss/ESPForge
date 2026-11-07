// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Mount the Direct dashboard: wire sections to the board session and render every store change. */

import { queryElement, setText } from "./dom.mjs";
import { selectConnection, selectStatusLine } from "../state/selectors.mjs";
import { renderConfiguration } from "./sections/configuration.mjs";
import { mountControls } from "./sections/controls.mjs";
import { renderDevice } from "./sections/device.mjs";
import { renderDiagnostics } from "./sections/diagnostics.mjs";
import { renderStorage } from "./sections/storage.mjs";
import { mountWirelessForm } from "./sections/wireless-form.mjs";

/**
 * @param {{ session: import("../board/session.mjs").BoardSession,
 *   environment: import("./sections/controls.mjs").Environment, root?: Document }} options
 */
export function mountDashboard({ session, environment, root = document }) {
  const abort = new AbortController();
  const renderControls = mountControls({ session, environment, root, signal: abort.signal });
  const renderWireless = mountWirelessForm({ session, root, signal: abort.signal });
  const connection = queryElement("div#connection", root);
  const statusLine = queryElement("footer#status-line", root);

  /** @param {import("../state/reducer.mjs").DashboardState} state */
  const render = state => {
    const link = selectConnection(state);
    connection.dataset.state = link.state;
    const line = selectStatusLine(state);
    statusLine.dataset.error = String(line.error);
    statusLine.dataset.active = String(line.active);
    setText({ "connection-label": link.label, "status-message": line.message }, root);
    renderDevice(state, root);
    renderConfiguration(state, root);
    renderDiagnostics(state, root, environment.formatTime);
    renderStorage(state, root);
    renderControls(state);
    renderWireless(state);
  };
  const unsubscribe = session.store.subscribe(render);
  render(session.store.getState());
  return {
    render,
    dispose() {
      unsubscribe();
      abort.abort();
    },
  };
}
