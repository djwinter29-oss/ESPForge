// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { identity, config, result, storage, telemetry, emit } from "../support/fixtures.mjs";

// A fake WebHID board installed before the production entry point reads navigator.hid.
const requests = [];
const sent = [];
const device = new EventTarget();
Object.assign(device, {
  vendorId: 0xcafe, productId: 0x4021, productName: "ESPForge",
  collections: [{ usagePage: 0xff00, usage: 1 }], opened: false,
  async open() { this.opened = true; },
  async close() { this.opened = false; },
  async sendFeatureReport(id, report) {
    sent.push([id, ...(ArrayBuffer.isView(report)
      ? new Uint8Array(report.buffer, report.byteOffset, report.byteLength) : new Uint8Array(report))]);
  },
  async receiveFeatureReport(id) {
    if (id === 1) return new DataView(identity().buffer);
    if (id === 2) return new DataView(config().buffer);
    if (id === 12) {
      const status = new Uint8Array(48);
      status[0] = 1;
      return new DataView(status.buffer);
    }
    const request = sent.at(-1);
    const reply = result(request[2], request[3]);
    if (request[3] === 5) reply.set(request.slice(5, 9), 5);
    return new DataView(reply.buffer);
  },
});
const hid = new EventTarget();
hid.getDevices = async () => [device];
hid.requestDevice = async options => { requests.push(options); return [device]; };
Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
Object.defineProperty(navigator, "bluetooth", { configurable: true, value: undefined });
window.directHid = {
  requests, sent,
  reports() { emit(device, 3, telemetry()); emit(device, 10, storage()); },
};
await import("../../web/js/app.mjs");
window.directHid.loaded = true;
