// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @file Dashboard composition: binds DOM intents to the board session, owns dialogs and dashboard-only UI state,
 * and renders coalesced board and UI snapshots.
 */
import { CAP } from "../protocol/constants.mjs";
import { createDashboardView, renderControls } from "./dashboard-view.mjs";
import { bindWirelessForm } from "./sections/wireless-form/wireless-form.mjs";
import { canRun } from "../state/selectors.mjs";
import { createUiStore, UI_INITIAL } from "../state/store.mjs";
import { queryElement } from "./dom.mjs";
import { deriveDashboardViewModel } from "./sections/status-model.mjs";
import { describe, UI_TEXT } from "./messages.mjs";
import { mountBoardOperationDialogs } from "./dialogs/board-operations.mjs";
import { mountConnectionDialogs } from "./dialogs/connection.mjs";
import { bindDialogEscape } from "./dialogs/keyboard.mjs";
import { mountSettingsDialogs } from "./dialogs/settings.mjs";
import { bindIdentityDetails } from "./sections/identity-details.mjs";
import { boardTargetDescription } from "./dialogs/board-confirmation.mjs";

/**
 * @typedef {{secure: boolean, hid: boolean, ble: boolean, now: () => number,
 *   clipboard: Pick<Clipboard, "writeText"> | null,
 *   consoleUrl?: (state: import("../state/reducer.mjs").DashboardState) => string | null}} DashboardEnvironment
 * @typedef {{session: import("../board/session.mjs").BoardSession,
 *   selectTransport: (kind: "usb" | "ble") => import("../board/session.mjs").BoardSession,
 *   timers: ReturnType<typeof import("../timers.mjs").createTimerScope>,
 *   environment: DashboardEnvironment}} DashboardOptions
 */

/**
 * @brief Wire the dashboard DOM to a board session: subscribe to its domain store, send user intents to it, render.
 * @param {DashboardOptions} options Injected session, timers, intents and browser facts.
 */
export function mountDashboard({ session, selectTransport, timers, environment }) {
  /** @param {string} id */
  const element = id => queryElement(`#${id}`);
  /** @param {string} id */
  const button = id => queryElement(`button#${id}`);
  let client = session;
  let disposed = false;
  const ui = createUiStore();
  /** @param {Partial<import("../state/reducer.mjs").UiState>} changes */
  const setUi = changes => ui.dispatch({ type: "patch", changes });
  const renderStatus = createDashboardView(environment.consoleUrl);
  const usbDialog = queryElement("dialog#usb-connection-dialog");
  const bluetoothDialog = queryElement("dialog#bluetooth-connection-dialog");
  const recoveryDialog = queryElement("dialog#recovery-abandon-dialog");
  bindIdentityDetails(["product-information", "module-memory"].map(id => queryElement(`details#${id}`)));
  let wasConnected = client.state.connected;
  let refreshQueued = false;
  /** Coalesce bursts of client state changes into one render and side-effect pass per microtask. */
  const scheduleRefresh = () => {
    if (refreshQueued || disposed) return;
    refreshQueued = true;
    queueMicrotask(refresh);
  };
  const bluetoothLink = () => client.state.link === "ble";
  /** @type {ReturnType<typeof bindWirelessForm>} */
  const wirelessForm = bindWirelessForm({
    supported: () => Boolean(client.state.hardware?.capabilities & CAP.WIRELESS),
    settingsReady: () => !bluetoothLink() && canRun(client.state, "settings").allowed,
    timerScope: timers,
    now: environment.now,
    clipboard: environment.clipboard,
    ready: () => canRun(client.state, "wireless").allowed,
    scan: signal => client.scanWireless(signal),
    test: (settings, onProgress, signal) => client.testWireless(settings, onProgress, signal),
    cancelTest: signal => client.cancelWireless(signal),
    changed: () => setUi({ wireless_form_busy: wirelessForm.operationBusy() }),
  });
  ui.subscribe(scheduleRefresh);
  let watched = null;
  let unwatch = () => {};
  /** Follow the session's domain store; a transport switch may hand over a session with a different store. */
  const watch = () => {
    if (watched === client.store) return;
    unwatch();
    watched = client.store;
    unwatch = watched.subscribe(scheduleRefresh);
  };
  const operationDialogs = mountBoardOperationDialogs({
    getSession: () => client,
    run: operation => run(operation),
    reportError: message => setUi({ action_error: message }),
  });
  const connectionDialogs = mountConnectionDialogs({
    getSession: () => client,
    hasUnsavedChanges: () => ui.getState().settings_dirty || wirelessForm.dirty(),
    reportError: message => setUi({ action_error: message }),
    setSession(session) {
      client = session;
      watch();
      scheduleRefresh();
    },
    selectTransport,
    run: operation => run(operation),
  });
  const settingsDialogs = mountSettingsDialogs({
    getSession: () => client,
    run: operation => run(operation),
    setUi,
    ui,
    wirelessForm,
    isDisposed: () => disposed,
  });
  const allDialogs = [...connectionDialogs, ...settingsDialogs.dialogs, ...operationDialogs.dialogs, recoveryDialog];
  watch();
  /** Reset dashboard-only state after a disconnect, then render once. Performs no device I/O. */
  function refresh() {
    refreshQueued = false;
    if (disposed) return;
    const board = client.state;
    if (wasConnected && !board.connected) {
      wirelessForm.reset();
      ui.dispatch({ type: "replace", state: { ...UI_INITIAL, action_error: ui.getState().action_error } });
      settingsDialogs.close();
      operationDialogs.close();
      recoveryDialog.close();
    }
    wasConnected = board.connected;
    render(board, ui.getState());
  }

  /**
   * @brief View update: reads board and UI state, writes only DOM and the form's adopted snapshot.
   * @param {import("../state/reducer.mjs").DashboardState} board
   * @param {import("../state/reducer.mjs").UiState} view
   */
  function render(board, view) {
    // Domain state carries reason codes; this is the one place they become text.
    const state = { ...board, error: describe(board.error), action_error: describe(view.action_error),
      recovery_message: describe(board.recovery_message), wireless_error: describe(board.wireless_error),
      wireless_poll_error: describe(board.wireless_poll_error) };
    const viewModel = deriveDashboardViewModel(state, view.wireless_form_busy);
    const settingsReady = canRun(board, "settings", viewModel.eligibility).allowed;
    const wirelessReady = canRun(board, "wireless", viewModel.eligibility).allowed;
    renderStatus({ ...state, ...viewModel }, viewModel);
    renderControls(state, { eligibility: viewModel.eligibility, formBusy: view.wireless_form_busy,
      settingsMessage: view.settings_message, bleName: client.deviceName, settingsDirty: view.settings_dirty,
      wirelessDirty: wirelessForm.dirty(),
      wirelessSaveBlockReason: wirelessForm.saveBlockReason() }, environment);
    const abandon = button("recovery-abandon");
    abandon.hidden = !board.outcome_uncertain;
    abandon.disabled = Boolean(board.busy || board.wireless_busy);
    wirelessForm.update(board, { wireless: wirelessReady, settings: !bluetoothLink() && settingsReady });
  }

  async function run(operation) {
    setUi({ action_error: null });
    try { await operation(); } catch (error) { setUi({ action_error: describe(error) }); }
  }

  element("led-colour").addEventListener("change", () => run(async () => {
    const control = /** @type {HTMLSelectElement} */ (element("led-colour"));
    if (!control.disabled) await client.setLedColour(Number(control.value));
  }));

  element("recovery-abandon").addEventListener("click", () => {
    if (button("recovery-abandon").hidden || button("recovery-abandon").disabled) return;
    element("recovery-abandon-warning").textContent =
      UI_TEXT.recoveryAbandonWarning(boardTargetDescription(client));
    recoveryDialog.showModal();
  });
  element("cancel-recovery-abandon").addEventListener("click", () => recoveryDialog.close());
  element("confirm-recovery-abandon").addEventListener("click", () => run(async () => {
    if (!recoveryDialog.open) return;
    recoveryDialog.close();
    if (!client.state.outcome_uncertain || client.state.busy || client.state.wireless_busy) return;
    await client.abandonRecovery();
  }));

  bindDialogEscape(allDialogs, connectionDialogs, () => client.state.busy);
  refresh();
  return {
    refresh: scheduleRefresh,
    dispose() {
      disposed = true;
      unwatch();
      wirelessForm.dispose();
    },
  };
}
