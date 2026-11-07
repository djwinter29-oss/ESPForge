// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/**
 * Browser-link contract consumed by the board session. A transport owns one browser link and validated framing;
 * it has no dashboard policy. `disconnect` is dispatched when the link is lost without `close()`.
 *
 * @typedef {EventTarget & {
 *   kind: "serial" | "ble" | "demo", label: string, writable: boolean, simulated: boolean,
 *   available: boolean, unavailableReason: string,
 *   connect: () => Promise<void>,
 *   status: () => Promise<import("../protocol/codec.mjs").BoardStatus>,
 *   wifiConnect: (credentials: import("../protocol/codec.mjs").WifiCredentials) => Promise<void>,
 *   close: () => Promise<void>,
 * }} Transport
 * @typedef {"serial" | "ble" | "demo"} TransportKind
 */
export {};
