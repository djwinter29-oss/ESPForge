// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file ESPForge management protocol v1 constants; see docs/reference/protocol.md. */

export const PRODUCT = "ESPForge";
export const PROTOCOL_VERSION = 1;

export const BLE_SERVICE_UUID = "7a9c0001-6d8e-4c21-a120-455350464f52";
export const BLE_STATUS_UUID = "7a9c0002-6d8e-4c21-a120-455350464f52";
/** Firmware bounds the BLE status snapshot below 512 bytes. */
export const BLE_STATUS_MAX_BYTES = 511;

export const SERIAL_OPTIONS = Object.freeze({
  baudRate: 115200, dataBits: 8, stopBits: 1, parity: /** @type {const} */ ("none"), bufferSize: 4096,
});
/** Includes the terminating LF. */
export const MAX_REQUEST_BYTES = 512;
export const MAX_REPLY_BYTES = 4096;
export const REQUEST_TIMEOUT_MS = 5000;
export const MAX_REQUEST_ID = 2147483647;
export const POLL_INTERVAL_MS = 1000;

export const SSID_MAX_BYTES = 32;
export const PSK_MIN_BYTES = 8;
export const PSK_MAX_BYTES = 63;

/** Result codes documented by the protocol; other values are shown numerically. */
export const RESULT_CODES = Object.freeze({
  wifi: Object.freeze({ 0: "OK", [-11]: "initialization pending", [-115]: "connect pending" }),
  ble: Object.freeze({ 0: "OK", [-11]: "initialization pending" }),
  sd: Object.freeze({ 0: "OK" }),
});

/** Device error replies documented by the protocol. */
export const DEVICE_ERRORS = Object.freeze({
  [-22]: "invalid request", [-95]: "unsupported operation", [-90]: "frame too large",
});
