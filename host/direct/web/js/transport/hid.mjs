// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { DEVICE_FILTER, PRODUCT_IDS } from "../protocol/constants.mjs";
import { matchesEspForge, requireValid } from "../protocol/codec.mjs";
import { BoardError, REASON } from "../state/errors.mjs";

/** @typedef {import("./transport.mjs").Transport} Transport */
/**
 * @brief WebHID byte pipe for one opened ESPForge device: Feature reports by ID and Input report events.
 * @implements {Transport}
 */
export class HidTransport extends EventTarget {
  constructor(hid) {
    super();
    /** @type {"usb"} */
    this.kind = "usb";
    this.api = hid;
    this.available = Boolean(hid);
    this.unavailableReason = REASON.WEBHID_UNAVAILABLE;
    this.autoReconnect = true;
    this.pollInterval = null;
    this.device = null;
    this.candidate = null;
    this.name = null;
    this.onReport = event => {
      if (event.device === this.device) this.dispatchEvent(Object.assign(new Event("report"),
        { reportId: event.reportId, data: event.data }));
    };
    this.onDisconnect = event => {
      if (event.device !== this.device) return;
      this.detach();
      this.dispatchEvent(new Event("disconnect"));
    };
    this.onConnect = event => {
      if (this.device || !matchesEspForge(event.device)) return;
      this.candidate = event.device;
      this.dispatchEvent(new Event("available"));
    };
    this.onSuspend = event => {
      if (event.device === this.device) this.dispatchEvent(new Event("suspend"));
    };
    hid?.addEventListener("disconnect", this.onDisconnect);
    hid?.addEventListener("connect", this.onConnect);
    hid?.addEventListener("suspend", this.onSuspend);
  }

  /** @brief Prompt for one ESPForge device and open it; @return false when the user selects none. */
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
  async reconnect(signal) {
    const device = this.candidate;
    this.candidate = null;
    if (!device) return false;
    await this.openDevice(device, signal);
    return true;
  }

  /** @brief Open `device` unless the connection signal aborts meanwhile, then forward its Input reports. */
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
  async writeReport(id, data, signal) {
    signal.throwIfAborted();
    const device = this.device;
    if (!device) throw new BoardError(REASON.USB_DISCONNECTED);
    await device.sendFeatureReport(id, data);
    signal.throwIfAborted();
    if (device !== this.device) throw new BoardError(REASON.USB_CHANGED);
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
