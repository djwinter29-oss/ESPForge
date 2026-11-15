// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file Shared Escape-key behavior for dashboard dialogs.
 */

/**
 * @brief Close non-connection dialogs on Escape; keep connection dialogs open during device I/O.
 * @param {HTMLDialogElement[]} dialogs All mounted dashboard dialogs.
 * @param {HTMLDialogElement[]} connectionDialogs Dialogs that remain open while the session is busy.
 * @param {() => boolean} isBusy
 */
export function bindDialogEscape(dialogs, connectionDialogs, isBusy) {
  for (const dialog of dialogs) {
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!isBusy() || !connectionDialogs.includes(dialog)) dialog.close();
    });
  }
}
