// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Pure encoding and validation for protocol v1 frames; no transport or DOM access. */

import {
  MAX_REQUEST_BYTES, MAX_REQUEST_ID, MAX_REPLY_BYTES, PRODUCT, PROTOCOL_VERSION, PSK_MAX_BYTES, PSK_MIN_BYTES,
  SSID_MAX_BYTES,
} from "./constants.mjs";

/**
 * @typedef {{
 *   protocol: 1, product: string, board: string, firmware: string, uptime_ms: number,
 *   wifi_enabled: boolean, ble_enabled: boolean, wifi_connected: boolean, wifi_error: number,
 *   ble_error: number, sd_mounted: boolean, sd_error: number
 * }} BoardStatus
 * @typedef {{ ssid: string, psk: string }} WifiCredentials
 * @typedef {{ id: number, ok: boolean, error?: number, status?: unknown }} Reply
 */

const encoder = new TextEncoder();
const byteLength = (/** @type {string} */ text) => encoder.encode(text).length;
const INTEGER_FIELDS = ["uptime_ms", "wifi_error", "ble_error", "sd_error"];
const BOOLEAN_FIELDS = ["wifi_enabled", "ble_enabled", "wifi_connected", "sd_mounted"];

/**
 * @brief Accept only a complete protocol v1 status object; never fills in missing values.
 * @param {unknown} value
 * @return {BoardStatus}
 */
export function validateStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid board status");
  const status = /** @type {Record<string, unknown>} */ (value);
  if (status.protocol !== PROTOCOL_VERSION || status.product !== PRODUCT) {
    throw new Error("Unsupported device or protocol");
  }
  for (const name of ["board", "firmware"]) {
    if (typeof status[name] !== "string" || !status[name]) throw new Error(`Invalid ${name}`);
  }
  for (const name of INTEGER_FIELDS) {
    if (!Number.isSafeInteger(status[name])) throw new Error(`Invalid ${name}`);
  }
  if (/** @type {number} */ (status.uptime_ms) < 0) throw new Error("Invalid uptime_ms");
  for (const name of BOOLEAN_FIELDS) {
    if (typeof status[name] !== "boolean") throw new Error(`Invalid ${name}`);
  }
  return /** @type {BoardStatus} */ (status);
}

/**
 * @brief Validate credentials by UTF-8 byte length, matching firmware limits.
 * @param {unknown} credentials
 * @return {WifiCredentials}
 */
export function validateWifiCredentials(credentials) {
  const { ssid, psk } = /** @type {Record<string, unknown>} */ (credentials ?? {});
  if (typeof ssid !== "string" || typeof psk !== "string" || ssid.includes("\0") || psk.includes("\0")) {
    throw new Error("Wi-Fi credentials must be text without NUL characters");
  }
  const ssidBytes = byteLength(ssid);
  const pskBytes = byteLength(psk);
  if (ssidBytes < 1 || ssidBytes > SSID_MAX_BYTES) throw new Error(`SSID must be 1-${SSID_MAX_BYTES} UTF-8 bytes`);
  if (pskBytes !== 0 && (pskBytes < PSK_MIN_BYTES || pskBytes > PSK_MAX_BYTES)) {
    throw new Error(`Passphrase must be empty or ${PSK_MIN_BYTES}-${PSK_MAX_BYTES} UTF-8 bytes`);
  }
  return { ssid, psk };
}

/** @param {string} text */
export const hexUtf8 = text => Array.from(encoder.encode(text), byte => byte.toString(16).padStart(2, "0")).join("");

/**
 * @brief Encode one LF-terminated request. Wi-Fi credentials travel as hex UTF-8 (encoding, not encryption).
 * @param {number} id
 * @param {"status" | "wifi.connect"} op
 * @param {WifiCredentials} [credentials]
 * @return {Uint8Array}
 */
export function encodeRequest(id, op, credentials) {
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_REQUEST_ID) throw new Error("Invalid request id");
  /** @type {Record<string, unknown>} */
  let body;
  if (op === "status") body = { id, op };
  else if (op === "wifi.connect") {
    const { ssid, psk } = validateWifiCredentials(credentials);
    body = { id, op, ssid_hex: hexUtf8(ssid), psk_hex: hexUtf8(psk) };
  } else throw new Error(`Unsupported operation: ${op}`);
  const bytes = encoder.encode(`${JSON.stringify(body)}\n`);
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES} bytes`);
  return bytes;
}

/**
 * @brief Decode one received line. Returns null for non-protocol text such as ROM boot messages.
 * @param {string} line Line without its LF.
 * @return {Reply | null}
 */
export function decodeReplyLine(line) {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  if (byteLength(text) > MAX_REPLY_BYTES) throw new Error("Board reply too large");
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Malformed board reply");
  }
  const reply = /** @type {Record<string, unknown>} */ (value);
  if (!reply || typeof reply !== "object" || !Number.isSafeInteger(reply.id) || typeof reply.ok !== "boolean") {
    throw new Error("Malformed board reply");
  }
  if (!reply.ok && !Number.isSafeInteger(reply.error)) throw new Error("Malformed board error reply");
  return /** @type {Reply} */ (/** @type {unknown} */ (reply));
}

/**
 * @brief Decode the BLE status characteristic (status JSON without a UART envelope).
 * @param {DataView | Uint8Array} data
 * @return {BoardStatus}
 */
export function decodeBleStatus(data) {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Malformed Bluetooth status");
  }
  return validateStatus(value);
}
