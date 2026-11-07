// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Error vocabulary shared by every layer (imports nothing) and user-facing text for browser exceptions. */

/** A well-formed `ok:false` reply: the board rejected the request but the link is healthy. */
export class DeviceError extends Error {
  name = "DeviceError";
  /**
   * @param {string} message
   * @param {number | undefined} code
   */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** @param {unknown} error */
const nameOf = error => (error && typeof error === "object" && "name" in error ? String(error.name) : "");

/**
 * @brief True when the user closed the browser device picker without choosing a board.
 * @param {unknown} error
 */
export const isChooserCancelled = error => nameOf(error) === "NotFoundError";

/**
 * @param {unknown} error
 * @return {string}
 */
export function errorMessage(error) {
  const message = error instanceof Error || (error && typeof error === "object" && "message" in error)
    ? String(/** @type {{ message: unknown }} */ (error).message) : String(error);
  switch (nameOf(error)) {
    case "SecurityError":
      return "The browser blocked device access. Serve Direct on localhost or HTTPS and use a button to connect.";
    case "InvalidStateError":
      return "The device is already open. Close other serial monitors, tabs, or flashing tools and try again.";
    case "NetworkError":
      return `Board link lost: ${message}`;
    default:
      return message || "Unknown error";
  }
}
