// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { OPCODES } from "../protocol/opcodes.mjs";
import { decodeIdentityReport, hexToBytes } from "../protocol/codec.mjs";
import { CAP } from "../protocol/constants.mjs";
import { wait } from "../timers.mjs";
import { BoardError, REASON } from "../state/errors.mjs";

export const BLE_SERVICE = "ef5c0000-7c91-4d70-8b32-6e856443f502";
const characteristic = id => `ef5c${id.toString(16).padStart(4, "0")}-7c91-4d70-8b32-6e856443f502`;
const GATT_SERVICE = 0x1801;
const SERVICE_CHANGED = 0x2a05;
/** @brief Required characteristics; benchmark and module-memory mirrors are discovered from identity. */
const CHARACTERISTICS = [1, 2, 3, 10, 12, 20, 256, 257];

/** @typedef {import("./transport.mjs").Transport} Transport */
/** @implements {Transport} */
export class BleTransport extends EventTarget {
  constructor(bluetooth, { sleep = wait } = {}) {
    super();
    /** @type {"ble"} */
    this.kind = "ble";
    this.api = bluetooth;
    this.available = Boolean(bluetooth);
    this.unavailableReason = REASON.BLUETOOTH_UNAVAILABLE;
    this.autoReconnect = false;
    this.pollInterval = 250;
    this.device = null;
    this.characteristics = new Map();
    this.gattQueue = Promise.resolve();
    this.bleKey = null;
    this.uid = null;
    this.connecting = false;
    this.sleep = sleep;
    this.onDisconnect = () => {
      if (this.connecting) return;
      this.bleKey = null;
      this.gattQueue = Promise.resolve();
      this.characteristics.clear();
      this.device?.removeEventListener("gattserverdisconnected", this.onDisconnect);
      this.device = null;
      this.dispatchEvent(new Event("disconnect"));
    };
  }

  get name() { return this.device?.name ?? null; }
  async reconnect() { return false; }

  /**
   * @brief Import the 32-byte Control key as a non-extractable HMAC key, then wipe the caller's bytes.
   * @param {Uint8Array<ArrayBuffer>} bytes Key bytes; zeroed on return.
   */
  async setControlKey(bytes) {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new BoardError(REASON.BLE_KEY_LENGTH);
      this.bleKey = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    } finally { if (bytes instanceof Uint8Array) bytes.fill(0); }
  }

  async prove(uid, request, signal) {
    signal.throwIfAborted();
    const value = await this.characteristics.get(256).readValue();
    signal.throwIfAborted();
    const nonce = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (nonce.length !== 16) {
      throw Object.assign(new BoardError(REASON.BLE_CHALLENGE), { final: true });
    }
    const message = new Uint8Array([...nonce, ...uid, ...new TextEncoder().encode("PFBLECTL1"), ...request]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", this.bleKey, message));
    signal.throwIfAborted();
    await this.characteristics.get(257).writeValueWithResponse(mac.slice(0, 16));
    signal.throwIfAborted();
  }

  async unlock(signal) {
    const value = await this.readReport(1, signal);
    const hardware = decodeIdentityReport(value);
    this.uid = hardware.serial_number;
    try { await this.prove(hexToBytes(this.uid), new TextEncoder().encode("SESSION01"), signal); }
    catch (error) {
      if (signal.aborted || error.final || !this.device?.gatt.connected) throw error;
      throw Object.assign(new BoardError(REASON.BLE_UNLOCK_REJECTED), { final: true });
    }
    return hardware;
  }

  async connect(key, signal) {
    if (!this.api) throw new BoardError(this.unavailableReason);
    signal.throwIfAborted();
    this.connecting = true;
    try {
      await this.setControlKey(key);
      signal.throwIfAborted();
      const device = await this.api.requestDevice({
        filters: [{ services: [BLE_SERVICE] }, { namePrefix: "ESPForge-" }],
        optionalServices: [BLE_SERVICE, GATT_SERVICE],
      });
      signal.throwIfAborted();
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.onDisconnect);
      // ponytail: retry only read-only setup, at most three times on the selected board; never retry a command.
      for (let attempt = 1; ; attempt++) {
        try {
          const server = await device.gatt.connect();
          signal.throwIfAborted();
          // Subscribe so cached handles are refreshed; Zephyr sends no forced indication, so never wait for one.
          try {
            const gatt = await server.getPrimaryService(GATT_SERVICE);
            await (await gatt.getCharacteristic(SERVICE_CHANGED)).startNotifications();
          } catch (error) {
            if (!["NotAllowedError", "NotFoundError", "NotSupportedError", "SecurityError"].includes(error?.name)) {
              throw error;
            }
            console.warn("Service Changed is unavailable; continuing with platform GATT cache behavior.", error);
          }
          signal.throwIfAborted();
          const service = await server.getPrimaryService(BLE_SERVICE);
          for (const id of CHARACTERISTICS) {
            this.characteristics.set(id, await service.getCharacteristic(characteristic(id)));
            signal.throwIfAborted();
          }
          const hardware = await this.unlock(signal);
          if (hardware.capabilities & CAP.SELF_TEST)
            this.characteristics.set(11, await service.getCharacteristic(characteristic(11)));
          if (hardware.memory_report_supported)
            this.characteristics.set(13, await service.getCharacteristic(characteristic(13)));
          return true;
        } catch (error) {
          device.gatt.disconnect();
          this.characteristics.clear();
          if (signal.aborted || attempt === 3 || error.final) throw error;
          await this.sleep(500, signal);
        }
      }
    } catch (error) {
      await this.disconnect();
      throw error;
    } finally { this.connecting = false; }
  }

  /**
   * @brief Serialize GATT I/O, keeping a proof and its write together and fencing queued work by connection.
   * @template T
   * @param {() => Promise<T>} operation
   * @param {AbortSignal} signal
   * @return {Promise<T>}
   */
  runGatt(operation, signal) {
    signal.throwIfAborted();
    const device = this.device;
    const result = this.gattQueue.then(() => {
      signal.throwIfAborted();
      if (device !== this.device) throw new BoardError(REASON.CONNECTION_CHANGED);
      return operation();
    });
    // The caller retains the rejection; only the queue tail recovers so later I/O can proceed.
    this.gattQueue = result.then(() => {}, () => {});
    return result;
  }

  async readReport(id, signal) {
    return this.runGatt(async () => {
      const value = await this.characteristics.get(id).readValue();
      signal.throwIfAborted();
      if (id !== 20) return value;
      if (value.byteLength !== 9) throw new BoardError(REASON.BLE_RESULT_LENGTH);
      const report = new Uint8Array(68);
      report.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return report;
    }, signal);
  }

  async writeReport(id, report, signal) {
    signal.throwIfAborted();
    // Framing only: the BLE request is the 9-byte prefix; link policy is enforced by the session before writing.
    if (id !== 20 || report.length !== 68 || report.subarray(9).some(Boolean)) {
      throw new BoardError(REASON.BLE_FRAME);
    }
    const request = report.slice(0, 9);
    return this.runGatt(async () => {
      try {
        if (OPCODES[request[2]]?.ble?.proof !== false) await this.prove(hexToBytes(this.uid), request, signal);
        signal.throwIfAborted();
        await this.characteristics.get(20).writeValueWithResponse(request);
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted || error.final || !this.device?.gatt.connected) throw error;
        throw new BoardError(REASON.BLE_PROOF_REJECTED);
      }
    }, signal);
  }

  async disconnect() {
    this.bleKey = null;
    this.gattQueue = Promise.resolve();
    this.characteristics.clear();
    this.device?.removeEventListener("gattserverdisconnected", this.onDisconnect);
    this.device?.gatt.disconnect();
    this.device = null;
  }

  async dispose() { await this.disconnect(); }
}
