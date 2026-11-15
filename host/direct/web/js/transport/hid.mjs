// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { DEVICE_FILTER, PRODUCT_IDS } from "../protocol/constants.mjs";
import { matchesEspForge, requireValid } from "../protocol/codec.mjs";
import { BoardError, errorValue, REASON } from "../state/errors.mjs";

/** @typedef {import("./transport.mjs").Transport} Transport */
/**
 * @typedef {EventTarget & {
 *   vendorId: number,
 *   productId: number,
 *   collections: Array<{usagePage: number, usage: number}>,
 *   opened: boolean,
 *   productName?: string | null,
 *   open: () => Promise<void>,
 *   close: () => Promise<void>,
 *   receiveFeatureReport: (id: number) => Promise<DataView>,
 *   sendFeatureReport: (id: number, data: Uint8Array) => Promise<void>,
 * }} HidDevice
 */
/**
 * @typedef {EventTarget & {
 *   requestDevice: (options: {filters: Array<{vendorId: number, productId: number,
 *     usagePage: number, usage: number}>}) => Promise<HidDevice[]>,
 *   getDevices: () => Promise<HidDevice[]>,
 * }} HidApi
 */
/** @typedef {Event & {device: HidDevice}} HidDeviceEvent */
/** @typedef {HidDeviceEvent & {reportId: number, data: DataView}} HidInputReportEvent */
/** @param {unknown} value @returns {value is HidDevice} */
const isHidDevice = value => value !== null && typeof value === "object"
  && value instanceof EventTarget && "vendorId" in value && typeof value.vendorId === "number"
  && "productId" in value && typeof value.productId === "number"
  && "collections" in value && Array.isArray(value.collections)
  && "opened" in value && typeof value.opened === "boolean"
  && "open" in value && typeof value.open === "function"
  && "close" in value && typeof value.close === "function"
  && "receiveFeatureReport" in value && typeof value.receiveFeatureReport === "function"
  && "sendFeatureReport" in value && typeof value.sendFeatureReport === "function";
/** @param {Event} event @returns {event is HidDeviceEvent} */
const isHidDeviceEvent = event => "device" in event && isHidDevice(event.device);
/** @param {Event} event @returns {event is HidInputReportEvent} */
const isHidInputReportEvent = event => isHidDeviceEvent(event)
  && "reportId" in event && typeof event.reportId === "number"
  && "data" in event && event.data instanceof DataView;
/**
 * @brief WebHID byte pipe for one opened ESPForge device: Feature reports by ID and Input report events.
 * @implements {Transport}
 */
export class HidTransport extends EventTarget {
  /** @param {HidApi | undefined} hid */
  constructor(hid) {
    super();
    /** @type {"usb"} */
    this.kind = "usb";
    this.api = hid;
    this.available = Boolean(hid);
    this.unavailableReason = REASON.WEBHID_UNAVAILABLE;
    this.autoReconnect = true;
    /** @type {number | null} */
    this.pollInterval = null;
    this.device = null;
    this.candidate = null;
    this.name = null;
    /** @param {Event} event */
    this.onReport = event => {
      if (!isHidInputReportEvent(event)) return;
      if (event.device === this.device) this.dispatchEvent(Object.assign(new Event("report"),
        { reportId: event.reportId, data: event.data }));
    };
    /** @param {Event} event */
    this.onDisconnect = event => {
      if (!isHidDeviceEvent(event)) return;
      if (event.device !== this.device) return;
      this.detach();
      this.dispatchEvent(new Event("disconnect"));
    };
    /** @param {Event} event */
    this.onConnect = event => {
      if (this.device || !isHidDeviceEvent(event) || !matchesEspForge(event.device)) return;
      this.candidate = event.device;
      this.dispatchEvent(new Event("available"));
    };
    /** @param {Event} event */
    this.onSuspend = event => {
      if (!isHidDeviceEvent(event)) return;
      if (event.device === this.device) this.dispatchEvent(new Event("suspend"));
    };
    hid?.addEventListener("disconnect", this.onDisconnect);
    hid?.addEventListener("connect", this.onConnect);
    hid?.addEventListener("suspend", this.onSuspend);
  }

  /** @brief Prompt for one ESPForge device and open it; @return false when the user selects none. */
  /** @param {Uint8Array | undefined} _options @param {AbortSignal} signal */
  async connect(_options, signal) {
    signal.throwIfAborted();
    if (!this.api) throw new BoardError(this.unavailableReason);
    const devices = await this.api.requestDevice({
      filters: PRODUCT_IDS.map(productId => ({ ...DEVICE_FILTER, productId })),
    });
    signal.throwIfAborted();
    if (!devices.length) return false;
    requireValid(devices.length === 1 && matchesEspForge(devices[0]), "device-selection");
    await this.openDevice(devices[0], signal);
    return true;
  }

  /** @brief Open the authorized device last announced by a WebHID connect event; @return false without one. */
  /** @param {AbortSignal} signal */
  async reconnect(signal) {
    const device = this.candidate;
    this.candidate = null;
    if (!device) return false;
    await this.openDevice(device, signal);
    return true;
  }

  /** @brief Open `device` unless the connection signal aborts meanwhile, then forward its Input reports. */
  /** @param {HidDevice} device @param {AbortSignal} signal */
  async openDevice(device, signal) {
    signal.throwIfAborted();
    if (!device.opened) await device.open();
    if (signal.aborted) {
      await device.close();
      signal.throwIfAborted();
    }
    this.device = device;
    this.name = device.productName ?? null;
    device.addEventListener("inputreport", this.onReport);
  }

  /** @brief Read Feature report `id`; fails if the device disconnects or changes meanwhile. */
  /** @param {number} id @param {AbortSignal} signal */
  async readReport(id, signal) {
    signal.throwIfAborted();
    const device = this.device;
    if (!device) throw new BoardError(REASON.USB_DISCONNECTED);
    const value = await device.receiveFeatureReport(id);
    signal.throwIfAborted();
    if (device !== this.device) throw new BoardError(REASON.USB_CHANGED);
    return value;
  }

  /** @brief Write Feature report `id` (payload without the report ID) with the same identity fencing. */
  /** @param {number} id @param {Uint8Array} data @param {AbortSignal} signal */
  async writeReport(id, data, signal) {
    signal.throwIfAborted();
    const device = this.device;
    if (!device) throw new BoardError(REASON.USB_DISCONNECTED);
    try {
      await device.sendFeatureReport(id, data);
      signal.throwIfAborted();
      if (device !== this.device) throw new BoardError(REASON.USB_CHANGED);
    } catch (error) {
      if (error instanceof BoardError && error.uncertain) throw error;
      throw new BoardError(REASON.OUTCOME_UNCERTAIN, errorValue(error));
    }
  }

  /** @brief Forget the open device without closing it; @return the detached device, if any. */
  detach() {
    const device = this.device;
    device?.removeEventListener("inputreport", this.onReport);
    this.device = null;
    this.name = null;
    return device;
  }

  /** @brief Detach and close the open device. */
  async disconnect() {
    const device = this.detach();
    if (device?.opened) await device.close();
  }

  /** @brief Remove WebHID listeners and disconnect; the transport is unusable afterwards. */
  async dispose() {
    this.api?.removeEventListener("disconnect", this.onDisconnect);
    this.api?.removeEventListener("connect", this.onConnect);
    this.api?.removeEventListener("suspend", this.onSuspend);
    this.candidate = null;
    await this.disconnect();
  }
}
