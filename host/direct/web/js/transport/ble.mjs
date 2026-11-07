// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Read-only Web Bluetooth link to the ESPForge status GATT characteristic. */

import { BLE_SERVICE_UUID, BLE_STATUS_MAX_BYTES, BLE_STATUS_UUID } from "../protocol/constants.mjs";
import { decodeBleStatus } from "../protocol/codec.mjs";

export class BleTransport extends EventTarget {
  kind = /** @type {const} */ ("ble");
  label = "Bluetooth LE (read-only)";
  writable = false;
  simulated = false;
  /** @type {any} */ device = null;
  /** @type {any} */ characteristic = null;
  closing = false;

  /** @param {any} bluetooth `navigator.bluetooth`, or undefined when unavailable. */
  constructor(bluetooth) {
    super();
    this.bluetooth = bluetooth;
    this.onDisconnected = () => {
      this.characteristic = null;
      if (!this.closing) this.dispatchEvent(new Event("disconnect"));
    };
  }

  get available() { return Boolean(this.bluetooth); }
  get unavailableReason() {
    return this.bluetooth ? "" : "Web Bluetooth is unavailable in this browser or operating system";
  }

  async connect() {
    if (!this.bluetooth) throw new Error(this.unavailableReason);
    this.device = await this.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE_UUID] }] });
    this.device.addEventListener("gattserverdisconnected", this.onDisconnected);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(BLE_STATUS_UUID);
  }

  async status() {
    if (!this.characteristic) throw new Error("Bluetooth board disconnected");
    const data = await this.characteristic.readValue();
    if (data.byteLength > BLE_STATUS_MAX_BYTES) throw new Error("Bluetooth status too large");
    return decodeBleStatus(data);
  }

  async wifiConnect() {
    throw new Error("Bluetooth is read-only; connect over USB to configure Wi-Fi");
  }

  async close() {
    this.closing = true;
    this.characteristic = null;
    this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}
