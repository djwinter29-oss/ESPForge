// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { describe } from "../../web/js/ui/messages.mjs";
import { BoardSession } from "../../web/js/board/session.mjs";
import { HidTransport } from "../../web/js/transport/hid.mjs";

/** @brief ESPForge capabilities: reboot, settings, SDMMC storage, wireless (0x96). */
export const CAPABILITIES = 2 | 4 | 16 | 128;

export function identity(capabilities = CAPABILITIES) {
  const bytes = new Uint8Array(26);
  bytes.set([1, 3, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 3, 1, 0, capabilities]);
  const view = new DataView(bytes.buffer);
  view.setUint32(18, 524288, true); view.setUint32(22, 65536, true);
  return bytes;
}
/** @brief Report 2: 240 MHz, UART0 on GPIO43/44, native SDMMC CLK/CMD/DAT0-3 on GPIO12/11/13/14/15/10. */
export function config(radios = 0) {
  return Uint8Array.from([1, 240, 0, 0, 0, 43, 44, 12, 11, 13, 14, 15, 10, 4 | radios << 3, 1, 255, 255]);
}
export function telemetry() {
  const bytes = new Uint8Array(22); bytes[0] = 1; bytes[21] = 5;
  const view = new DataView(bytes.buffer);
  view.setInt16(2, -1234, true); view.setBigUint64(4, 123000n, true);
  view.setUint16(12, 1234, true); view.setUint16(14, 65535, true); view.setUint32(16, 240000000, true);
  return bytes;
}
/** @brief Report 10 with a mounted SDMMC card: no CID, no MSC. */
export function storage() {
  const bytes = new Uint8Array(34); bytes.set([1, 0, 111, 1, 3]);
  const view = new DataView(bytes.buffer);
  view.setUint32(5, 25000000, true); bytes[9] = 1; view.setUint32(10, 100000, true);
  bytes[30] = 3;
  return bytes;
}
export function result(transaction, opcode, status = 2, error = 0) {
  const bytes = new Uint8Array(68);
  bytes.set([1, transaction, opcode, status, error]);
  return bytes;
}
export function emit(device, reportId, data) {
  device.dispatchEvent(Object.assign(new Event("inputreport"), { device, reportId, data: new DataView(data.buffer) }));
}
export function fakeConnection({ capabilities, ...options } = {}) {
  const reads = [];
  const sent = [];
  const saved = new Map();
  const pendingStore = {
    getItem(key) { return saved.get(key) ?? null; },
    setItem(key, value) { saved.set(key, value); },
    removeItem(key) { saved.delete(key); },
  };
  const device = new EventTarget();
  Object.assign(device, { vendorId: 0xcafe, productId: 0x4021,
    collections: [{ usagePage: 0xff00, usage: 1 }], opened: false,
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async sendFeatureReport(id, report) { sent.push([id, ...report]); },
    async receiveFeatureReport(id) {
      reads.push(id);
      if (id === 1) return identity(capabilities);
      if (id === 2) return config();
      if (id === 12) { const status = new Uint8Array(48); status[0] = 1; return status; }
      const request = sent.at(-1);
      const reply = result(request[2], request[3]);
      if (request[3] === 5) reply.set(request.slice(5, 9), 5);
      return reply;
    } });
  const hid = new EventTarget(); hid.getDevices = async () => [device];
  hid.requestDevice = async () => [device];
  const client = new BoardSession(new HidTransport(hid),
    { sleep: async () => {}, pendingStore, wirelessPolling: false, ...options });
  return { client, device, hid, reads, sent, pendingStore };
}

export async function attachDevice(client, device) {
  await client.transport.openDevice(device, client.connectionSignal);
  await client.connection.initialize();
}

/** @brief `assert.rejects` validator: the rejection's user-visible text (via `describe`) matches `pattern`. */
export const says = pattern => error => {
  if (!pattern.test(describe(error))) throw new Error(`"${describe(error)}" does not match ${pattern}`);
  return true;
};

/** @brief Test-only state override: replace the domain snapshot with `changes` merged in (bypasses named events). */
export function patchState(client, changes) {
  client.store.dispatch({ type: "replace", state: { ...client.state, ...changes } });
}
