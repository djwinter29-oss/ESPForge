// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file User-facing strings that are not derived from board state. */

export const MESSAGES = Object.freeze({
  serialUnavailable: "Web Serial requires desktop Chrome or Edge on localhost or HTTPS.",
  bleUnavailable: "Web Bluetooth is unavailable in this browser or operating system, or the page is not on "
    + "localhost or HTTPS.",
  picker: "Waiting for the browser device picker…",
  submitting: "Submitting Wi-Fi request…",
  linkLost: "The board link closed. Reconnect to continue.",
});
