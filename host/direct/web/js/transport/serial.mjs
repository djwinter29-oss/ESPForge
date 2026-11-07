// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Web Serial link to the DevKitC USB-to-UART bridge using LF-delimited protocol v1 JSON. */

import {
  DEVICE_ERRORS, MAX_REPLY_BYTES, MAX_REQUEST_ID, REQUEST_TIMEOUT_MS, SERIAL_OPTIONS,
} from "../protocol/constants.mjs";
import { decodeReplyLine, encodeRequest, validateStatus } from "../protocol/codec.mjs";
import { DeviceError } from "../state/errors.mjs";

/**
 * @typedef {{ setTimeout: (callback: () => void, delay: number) => number, clearTimeout: (id: number) => void }} Timers
 * @typedef {{ id: number, resolve: (reply: import("../protocol/codec.mjs").Reply) => void,
 *   reject: (error: Error) => void, timer: number }} PendingRequest
 */

/** @param {number | undefined} code */
export function describeDeviceError(code) {
  const name = DEVICE_ERRORS[/** @type {keyof typeof DEVICE_ERRORS} */ (code)];
  return name ? `${code}, ${name}` : String(code);
}

export class SerialTransport extends EventTarget {
  kind = /** @type {const} */ ("serial");
  label = "USB-UART";
  writable = true;
  simulated = false;
  /** @type {any} */ port = null;
  /** @type {any} */ reader = null;
  /** @type {any} */ writer = null;
  /** @type {Promise<void> | null} */ readTask = null;
  /** @type {PendingRequest | null} */ pending = null;
  /** @type {Error | null} */ failure = null;
  nextId = 0;
  opened = false;
  closing = false;

  /**
   * @param {any} serial `navigator.serial`, or undefined when unavailable.
   * @param {Timers} timers
   */
  constructor(serial, timers) {
    super();
    this.serial = serial;
    this.timers = timers;
  }

  get available() { return Boolean(this.serial); }
  get unavailableReason() {
    return this.serial ? "" : "Web Serial requires desktop Chrome or Edge on localhost or HTTPS";
  }

  async connect() {
    if (!this.serial) throw new Error(this.unavailableReason);
    this.port = await this.serial.requestPort();
    await this.port.open(SERIAL_OPTIONS);
    this.opened = true;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readTask = this.readLoop(this.reader);
  }

  /** @param {any} reader */
  async readLoop(reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          this.handleLine(line);
        }
        if (buffer.length > MAX_REPLY_BYTES) throw new Error("Board reply too large");
      }
      this.failure = new Error("Board serial port closed");
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.settle(this.failure ?? new Error("Board serial port closed"));
      reader.releaseLock();
      this.reader = null;
      if (!this.closing) this.dispatchEvent(new Event("disconnect"));
    }
  }

  /** @param {string} line */
  handleLine(line) {
    const reply = decodeReplyLine(line);
    if (!reply || !this.pending) return;
    if (reply.id === 0 && !reply.ok) {
      this.settle(new DeviceError(`Board rejected the request frame (${describeDeviceError(reply.error)})`, reply.error));
    } else if (reply.id === this.pending.id) {
      if (reply.ok) this.settle(null, reply);
      else this.settle(new DeviceError(`Board error ${describeDeviceError(reply.error)}`, reply.error));
    }
  }

  /**
   * @param {Error | null} error
   * @param {import("../protocol/codec.mjs").Reply} [reply]
   */
  settle(error, reply) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(/** @type {import("../protocol/codec.mjs").Reply} */ (reply));
  }

  /**
   * @brief Send one request; commands are never retried automatically.
   * @param {"status" | "wifi.connect"} op
   * @param {import("../protocol/codec.mjs").WifiCredentials} [credentials]
   */
  async request(op, credentials) {
    if (this.failure) throw this.failure;
    if (!this.writer) throw new Error("Board is not connected");
    if (this.pending) throw new Error("Another board request is active");
    this.nextId = this.nextId % MAX_REQUEST_ID + 1;
    const id = this.nextId;
    const bytes = encodeRequest(id, op, credentials);
    /** @type {Promise<import("../protocol/codec.mjs").Reply>} */
    const response = new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = null;
          reject(new Error(`Board did not reply within ${REQUEST_TIMEOUT_MS / 1000} s; the command was not retried`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending = { id, resolve, reject, timer };
    });
    try {
      await this.writer.write(bytes);
    } catch (error) {
      if (this.pending?.id === id) this.settle(error instanceof Error ? error : new Error(String(error)));
    }
    return response;
  }

  async status() {
    return validateStatus((await this.request("status")).status);
  }

  /** @param {import("../protocol/codec.mjs").WifiCredentials} credentials */
  async wifiConnect(credentials) {
    await this.request("wifi.connect", credentials);
  }

  async close() {
    this.closing = true;
    try {
      if (this.reader) await this.reader.cancel();
      await this.readTask;
    } finally {
      this.writer?.releaseLock();
      this.writer = null;
      if (this.opened) {
        this.opened = false;
        await this.port.close();
      }
    }
  }
}
