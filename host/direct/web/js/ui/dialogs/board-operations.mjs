// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file Storage benchmark and USB ownership confirmation handlers.
 */
import { queryElement } from "../dom.mjs";
import { UI_TEXT } from "../messages.mjs";
import { captureBoardTarget, runBoardConfirmation } from "./board-confirmation.mjs";

/**
 * @typedef {{getSession: () => import("../../board/session.mjs").BoardSession,
 *   run: (operation: () => Promise<void>) => void,
 *   reportError: (message: string) => void}} BoardOperationDialogOptions
 */

/**
 * @brief Bind guarded benchmark and USB storage ownership dialogs.
 * @param {BoardOperationDialogOptions} options
 */
export function mountBoardOperationDialogs({ getSession, run, reportError }) {
  /** @param {string} id */
  const element = id => queryElement(`#${id}`);
  /** @param {string} id */
  const button = id => queryElement(`button#${id}`);
  const benchmarkDialog = queryElement("dialog#benchmark-start-dialog");
  const mscDialog = queryElement("dialog#msc-dialog");
  /** @type {ReturnType<typeof captureBoardTarget> | null} */
  let benchmarkTarget = null;
  /** @type {ReturnType<typeof captureBoardTarget> | null} */
  let storageTarget = null;
  let benchmarkSize = 0;
  let storageEnabled = false;

  element("benchmark-start").addEventListener("click", () => {
    if (button("benchmark-start").disabled) return;
    benchmarkSize = Number(/** @type {HTMLInputElement} */ (element("benchmark-size")).value);
    benchmarkTarget = captureBoardTarget(getSession());
    element("benchmark-start-warning").textContent = UI_TEXT.benchmarkWarning(benchmarkSize);
    benchmarkDialog.showModal();
  });
  element("cancel-benchmark-start").addEventListener("click", () => {
    benchmarkTarget = null;
    benchmarkDialog.close();
  });
  element("confirm-benchmark-start").addEventListener("click", () => run(async () => {
    if (!benchmarkDialog.open) return;
    const target = benchmarkTarget;
    benchmarkTarget = null;
    benchmarkDialog.close();
    await runBoardConfirmation(target, getSession, reportError, UI_TEXT.benchmarkBoardChanged,
      session => session.benchmark(true, benchmarkSize, true));
  }));
  element("benchmark-cancel").addEventListener("click", () => run(async () => {
    const session = getSession();
    if (!button("benchmark-cancel").disabled) await session.benchmark(false, 0, false);
  }));

  for (const [id, enabled] of /** @type {[string, boolean][]} */ (
    [["msc-enable", true], ["msc-return", false]])) {
    button(id).addEventListener("click", () => {
      if (button(id).disabled) return;
      storageEnabled = enabled;
      storageTarget = captureBoardTarget(getSession());
      element("msc-dialog-title").textContent = UI_TEXT.storageTitle(enabled);
      element("msc-warning").textContent = UI_TEXT.storageWarning(enabled);
      element("confirm-msc").textContent = UI_TEXT.storageConfirm(enabled);
      mscDialog.showModal();
    });
  }
  element("cancel-msc").addEventListener("click", () => {
    storageTarget = null;
    mscDialog.close();
  });
  element("confirm-msc").addEventListener("click", () => run(async () => {
    if (!mscDialog.open) return;
    const target = storageTarget;
    const enabled = storageEnabled;
    storageTarget = null;
    mscDialog.close();
    if (target?.link === "ble") {
      reportError(UI_TEXT.storageBoardChanged);
      return;
    }
    await runBoardConfirmation(target, getSession, reportError, UI_TEXT.storageBoardChanged,
      session => session.setMsc(enabled, !enabled));
  }));

  return {
    /** @brief Close operation dialogs after the board disconnects and discard their confirmations. */
    close() {
      benchmarkTarget = null;
      storageTarget = null;
      benchmarkDialog.close();
      mscDialog.close();
    },
    /** @brief Register keyboard dismissal for both operation dialogs. */
    dialogs: [benchmarkDialog, mscDialog],
  };
}
