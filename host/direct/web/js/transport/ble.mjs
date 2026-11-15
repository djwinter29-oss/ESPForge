// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { OPCODES } from "../protocol/opcodes.mjs";
import { decodeIdentityReport, hexToBytes } from "../protocol/codec.mjs";
import { CAP } from "../protocol/constants.mjs";
import { wait } from "../timers.mjs";
import { BoardError, errorValue, REASON } from "../state/errors.mjs";

/** @brief ESPForge's primary Bluetooth LE service UUID. */
export const BLE_SERVICE = "ef5c0000-7c91-4d70-8b32-6e856443f502";
/** @param {number} id */
const characteristic = id => `ef5c${id.toString(16).padStart(4, "0")}-7c91-4d70-8b32-6e856443f502`;
const GATT_SERVICE = 0x1801;
const SERVICE_CHANGED = 0x2a05;
/** @brief Required characteristics; benchmark and module-memory mirrors are discovered from identity. */
const CHARACTERISTICS = [1, 2, 3, 10, 12, 20, 256, 257];
const encoder = new TextEncoder();
const PROOF_DOMAIN = encoder.encode("PFBLECTL1");
const SESSION_REQUEST = encoder.encode("SESSION01");
/** @param {unknown} error */
const errorName = error => error instanceof Error ? error.name : "";
/** @param {unknown} error */
const isFinalError = error => error !== null && typeof error === "object"
  && "final" in error && error.final === true;

/**
 * @typedef {object} BleCharacteristic
 * @property {() => Promise<DataView>} readValue
 * @property {(value: Uint8Array) => Promise<void>} writeValueWithResponse
 * @property {() => Promise<unknown>} startNotifications
 */
/** @typedef {{getCharacteristic: (uuid: string | number) => Promise<BleCharacteristic>}} BleService */
/** @typedef {{getPrimaryService: (uuid: string | number) => Promise<BleService>}} BleServer */
/**
 * @typedef {EventTarget & {
 *   name?: string | null,
 *   gatt: {connected: boolean, connect: () => Promise<BleServer>, disconnect: () => void},
 * }} BleDevice
 */
/**
 * @typedef {object} BleApi
 * @property {(options: {filters: Array<{services: string[]} | {namePrefix: string}>,
 *   optionalServices: Array<string | number>}) => Promise<BleDevice>} requestDevice
 */
/** @typedef {import("./transport.mjs").Transport} Transport */
/**
 * @brief Web Bluetooth byte pipe over the ESPForge GATT report mirrors, with session and per-request HMAC proofs.
 * @implements {Transport}
 */
export class BleTransport extends EventTarget {
  /**
   * @param {BleApi | undefined} bluetooth
   * @param {{sleep?: typeof wait}} [options]
   */
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
    /** @type {Map<number, BleCharacteristic>} */
    this.characteristics = new Map();
    this.gattQueue = Promise.resolve();
    /** @type {CryptoKey | null} */
    this.bleKey = null;
    /** @type {string | null} */
    this.uid = null;
    this.connecting = false;
    this.sleep = sleep;
    this.onDisconnect = () => {
      if (this.connecting) return;
      this.detach();
      this.dispatchEvent(new Event("disconnect"));
    };
  }

  get name() { return this.device?.name ?? null; }
  async reconnect() { return false; }

  /**
   * @brief Import the 32-byte Control key as a non-extractable HMAC key, then wipe the caller's bytes.
   * @param {Uint8Array | undefined} bytes Key bytes; zeroed on return.
   */
  async setControlKey(bytes) {
    let raw = null;
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new BoardError(REASON.BLE_KEY_LENGTH);
      raw = new Uint8Array(bytes);
      this.bleKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    } finally {
      raw?.fill(0);
      bytes?.fill(0);
    }
  }

  /** @param {number} id */
  getCharacteristic(id) {
    const value = this.characteristics.get(id);
    if (!value) throw new BoardError(REASON.CONNECTION_CHANGED);
    return value;
  }

  /** @brief Answer a fresh nonce with the truncated HMAC of nonce, board UID, proof domain and `request`. */
  /** @param {Uint8Array} uid @param {Uint8Array} request @param {AbortSignal} signal */
  async prove(uid, request, signal) {
    signal.throwIfAborted();
    const key = this.bleKey;
    if (!key) throw new BoardError(REASON.BLE_UNLOCK_REJECTED);
    const value = await this.getCharacteristic(256).readValue();
    signal.throwIfAborted();
    const nonce = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (nonce.length !== 16) {
      throw Object.assign(new BoardError(REASON.BLE_CHALLENGE), { final: true });
    }
    const message = new Uint8Array([...nonce, ...uid, ...PROOF_DOMAIN, ...request]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
    signal.throwIfAborted();
    await this.getCharacteristic(257).writeValueWithResponse(mac.slice(0, 16));
    signal.throwIfAborted();
  }

  /** @brief Read identity and prove the session with the Control key; @return the decoded identity. */
  /** @param {AbortSignal} signal */
  async unlock(signal) {
    const value = await this.readReport(1, signal);
    const hardware = decodeIdentityReport(value);
    this.uid = hardware.serial_number;
    try { await this.prove(hexToBytes(this.uid), SESSION_REQUEST, signal); }
    catch (error) {
      if (signal.aborted || isFinalError(error) || !this.device?.gatt.connected) throw error;
      throw Object.assign(new BoardError(REASON.BLE_UNLOCK_REJECTED), { final: true });
    }
    return hardware;
  }

  /**
   * @brief Import `key`, prompt for a board, discover its mirrors and unlock the session.
   * @param {Uint8Array | undefined} key
   * @param {AbortSignal} signal
   * @return {Promise<boolean>} true once unlocked; failures disconnect and rethrow.
   */
  async connect(key, signal) {
    const api = this.api;
    if (!api) throw new BoardError(this.unavailableReason);
    signal.throwIfAborted();
    this.connecting = true;
    try {
      await this.setControlKey(key);
      signal.throwIfAborted();
      const device = await api.requestDevice({
        filters: [{ services: [BLE_SERVICE] }, { namePrefix: "ESPForge-" }],
        optionalServices: [BLE_SERVICE, GATT_SERVICE],
      });
      signal.throwIfAborted();
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.onDisconnect);
      // Retry only read-only setup, at most three times on the selected board; never retry a command.
      for (let attempt = 1; ; attempt++) {
        try {
          const server = await device.gatt.connect();
          signal.throwIfAborted();
          // Subscribe so cached handles are refreshed; Zephyr sends no forced indication, so never wait for one.
          try {
            const gatt = await server.getPrimaryService(GATT_SERVICE);
            await (await gatt.getCharacteristic(SERVICE_CHANGED)).startNotifications();
          } catch (error) {
            if (!["NotAllowedError", "NotFoundError", "NotSupportedError", "SecurityError"].includes(errorName(error))) {
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
          if (signal.aborted || attempt === 3 || isFinalError(error)) throw error;
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

  /** @brief Read a mirror; a 9-byte control result is zero-extended to the 68-byte Feature 20 layout. */
  /** @param {number} id @param {AbortSignal} signal */
  async readReport(id, signal) {
    return this.runGatt(async () => {
      const value = await this.getCharacteristic(id).readValue();
      signal.throwIfAborted();
      if (id !== 20) return value;
      if (value.byteLength !== 9) throw new BoardError(REASON.BLE_RESULT_LENGTH);
      const report = new Uint8Array(68);
      report.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return report;
    }, signal);
  }

  /** @brief Write a control request as its 9-byte prefix, after a proof unless the opcode is exempt. */
  /** @param {number} id @param {Uint8Array} report @param {AbortSignal} signal */
  async writeReport(id, report, signal) {
    signal.throwIfAborted();
    // Framing only: the BLE request is the 9-byte prefix; link policy is enforced by the session before writing.
    if (id !== 20 || report.length !== 68 || report.subarray(9).some(Boolean)) {
      throw new BoardError(REASON.BLE_FRAME);
    }
    const request = report.slice(0, 9);
    return this.runGatt(async () => {
      if (OPCODES[request[2]]?.ble?.proof !== false) {
        if (!this.uid) throw new BoardError(REASON.BLE_UNLOCK_REJECTED);
        try {
          await this.prove(hexToBytes(this.uid), request, signal);
        } catch (error) {
          if (signal.aborted || isFinalError(error) || !this.device?.gatt.connected) throw error;
          throw new BoardError(REASON.BLE_PROOF_REJECTED);
        }
      }
      signal.throwIfAborted();
      try {
        await this.getCharacteristic(20).writeValueWithResponse(request);
        signal.throwIfAborted();
      } catch (error) {
        throw new BoardError(REASON.OUTCOME_UNCERTAIN, errorValue(error));
      }
    }, signal);
  }

  /** @brief Forget the session key, queued GATT work and handles; @return the detached device, if any. */
  detach() {
    const device = this.device;
    this.bleKey = null;
    this.gattQueue = Promise.resolve();
    this.characteristics.clear();
    device?.removeEventListener("gattserverdisconnected", this.onDisconnect);
    this.device = null;
    return device;
  }

  /** @brief Detach, then close the GATT connection. */
  async disconnect() { this.detach()?.gatt.disconnect(); }

  async dispose() { await this.disconnect(); }
}
