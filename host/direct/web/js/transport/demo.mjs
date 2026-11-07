// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Explicit simulated preview; never presented as hardware and never accepts board commands. */

import { PRODUCT, PROTOCOL_VERSION } from "../protocol/constants.mjs";

/** @return {import("../protocol/codec.mjs").BoardStatus} */
export const simulatedStatus = (uptimeMs = 123000) => ({
  protocol: PROTOCOL_VERSION, product: PRODUCT, board: "ESP32-S3-DevKitC", firmware: "0.1.0 (simulated)",
  uptime_ms: uptimeMs, wifi_enabled: true, ble_enabled: true, wifi_connected: false,
  wifi_error: 0, ble_error: 0, sd_mounted: false, sd_error: -19,
});

export class DemoTransport extends EventTarget {
  kind = /** @type {const} */ ("demo");
  label = "Simulated preview";
  writable = false;
  simulated = true;
  available = true;
  unavailableReason = "";
  startedAt = 0;

  /** @param {() => number} now */
  constructor(now) {
    super();
    this.now = now;
  }

  async connect() { this.startedAt = this.now(); }

  async status() { return simulatedStatus(123000 + Math.max(0, this.now() - this.startedAt)); }

  async wifiConnect() {
    throw new Error("Simulated preview does not send board commands");
  }

  async close() {}
}
