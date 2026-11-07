// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, webcrypto } from "node:crypto";
import { describe } from "../../web/js/ui/messages.mjs";
import { BleTransport, BLE_SERVICE } from "../../web/js/transport/ble.mjs";
import { BoardSession } from "../../web/js/board/session.mjs";
import {
  fakeConnection, storage, identity, config, telemetry, result, patchState, says,
} from "../support/fixtures.mjs";
import { status } from "../support/wireless.mjs";

test("BLE maps normalized68byte control to restricted9byte wire form and HMACs those exact bytes", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const previousWarn = console.warn;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  const setup = fakeConnection();
  const writes = [], requested = [], requestedServices = [], discoveryOrder = [];
  let notificationStarts = 0;
  let serviceChangedAvailable = true;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  const nonce = Uint8Array.from({ length: 16 }, (_, index) => index);
  const ble = new EventTarget();
  const values = { 1: identity(), 2: config(), 3: telemetry(), 10: storage(), 12: status(), 256: nonce };
  ble.gatt = { connected: false,
    async connect() {
      this.connected = true;
      return { async getPrimaryService(uuid) {
        if (uuid === 0x1801) {
          if (!serviceChangedAvailable) throw Object.assign(new Error("Service is hidden"), { name: "NotFoundError" });
          return { async getCharacteristic(uuid) {
            assert.equal(uuid, 0x2a05);
            return { async startNotifications() {
              notificationStarts++;
              discoveryOrder.push("service_changed_subscription");
            } };
          } };
        }
        assert.equal(uuid, BLE_SERVICE);
        discoveryOrder.push("espforge_service_discovery");
        return { async getCharacteristic(uuid) {
          assert.match(uuid, /^ef5c[0-9a-f]{4}-7c91-4d70-8b32-6e856443f502$/);
          const id = parseInt(uuid.slice(4, 8), 16); requested.push(id);
          return {
            async readValue() {
              const request = writes.findLast(([id]) => id === 20)?.[1];
              const bytes = id === 20 ? result(request[1], request[2]).slice(0, 9) : values[id];
              if (id === 20 && request[2] === 5) bytes.set(request.slice(4, 8), 5);
              return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            },
            async writeValueWithResponse(bytes) { writes.push([id, [...bytes]]); },
          };
        } };
      } };
    },
    disconnect() { this.connected = false; ble.dispatchEvent(new Event("gattserverdisconnected")); },
  };
  let filters;
  const client = new BoardSession(new BleTransport({ requestDevice: async options => {
    requestedServices.push(...options.optionalServices);
    filters = options.filters;
    return ble;
  } }),
    { pendingStore: setup.pendingStore, wirelessPolling: false });
  try {
    await client.connect(new Uint8Array(32).fill(0xab));
    assert.equal(client.state.connected, true);
    assert.equal(BLE_SERVICE, "ef5c0000-7c91-4d70-8b32-6e856443f502");
    assert.deepEqual(filters, [{ services: [BLE_SERVICE] }, { namePrefix: "ESPForge-" }]);
    assert.ok(requestedServices.includes(0x1801));
    assert.equal(notificationStarts, 1);
    assert.deepEqual(discoveryOrder.slice(0, 2), ["service_changed_subscription", "espforge_service_discovery"]);
    assert.deepEqual(requested, [1, 2, 3, 10, 12, 20, 256, 257], "000b (report 11) is never discovered");
    const sign = request => [...createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
      .update(Buffer.concat([nonce, Buffer.from("0102030405060708", "hex"), Buffer.from("PFBLECTL1"),
        Buffer.from(request)])).digest().subarray(0, 16)];
    assert.deepEqual(writes[0], [257, sign(Buffer.from("SESSION01"))]);
    writes.length = 0;
    await client.command(2, { flags: 1 });
    assert.deepEqual(writes[1], [20, [1, 1, 2, 1, 0, 0, 0, 0, 0]]);
    assert.deepEqual(writes[0], [257, sign(writes[1][1])]);
    patchState(client, { reboot_pending: false });
    writes.length = 0;
    await client.command(5, { args: [160, 0, 0, 3] });
    assert.deepEqual(writes[1], [20, [1, 2, 5, 0, 160, 0, 0, 3, 0]]);
    assert.deepEqual(writes[0], [257, sign(writes[1][1])]);
    patchState(client, { reboot_pending: false });
    await assert.rejects(client.command(5, { flags: 2, args: [160, 0, 0, 3] }), says(/requires USB/));
    for (const opcode of [1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13]) {
      await assert.rejects(client.command(opcode), says(/requires USB/));
    }
    await client.readWireless();
    assert.equal(client.state.wireless.ssid_hex, "");
    await client.disconnect();
    serviceChangedAvailable = false;
    await client.connect(new Uint8Array(32).fill(0xab));
    assert.equal(client.state.connected, true);
    assert.equal(notificationStarts, 1);
    assert.ok(warnings.some(([message]) => message.includes("Service Changed is unavailable")));
  } finally {
    await client.disconnect();
    console.warn = previousWarn;
    if (previous) Object.defineProperty(globalThis, "crypto", previous);
    else delete globalThis.crypto;
  }
});

test("BLE discovery retries only read-only setup on the chosen board and retains the final failure", async () => {
  const ble = new EventTarget();
  const values = { 1: identity(), 2: config(), 3: telemetry(), 10: storage(), 12: status(),
    256: new Uint8Array(16) };
  let failures = 1, connects = 0, prompts = 0;
  ble.gatt = { connected: false,
    async connect() {
      connects++; this.connected = true;
      return { async getPrimaryService(uuid) {
        if (uuid === 0x1801) {
          return { async getCharacteristic() {
            return { async startNotifications() {} };
          } };
        }
        if (failures-- > 0) throw new Error("No matching service");
        return { async getCharacteristic(uuid) {
          const bytes = values[parseInt(uuid.slice(4, 8), 16)] ?? new Uint8Array(9);
          return { readValue: async () => new DataView(bytes.buffer), writeValueWithResponse: async () => {} };
        } };
      } };
    },
    disconnect() { this.connected = false; ble.dispatchEvent(new Event("gattserverdisconnected")); },
  };
  const client = new BoardSession(new BleTransport({ requestDevice: async () => { prompts++; return ble; } },
    { sleep: async () => {} }),
    { pendingStore: fakeConnection().pendingStore, sleep: async () => {}, wirelessPolling: false });
  await client.connect(new Uint8Array(32).fill(0xab));
  assert.equal(client.state.connected, true);
  assert.deepEqual([prompts, connects], [1, 2]);
  await client.disconnect();
  failures = 3; connects = 0;
  await client.connect(new Uint8Array(32).fill(0xab));
  assert.equal(client.state.connected, false);
  assert.equal(connects, 3);
  assert.match(describe(client.state.error), /No matching service/);
  assert.equal(client.transport.bleKey, null);
});

test("the bluetooth.md worked proof vector signs SESSION01 and a confirmed reboot", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  try {
    const nonce = Uint8Array.from({ length: 16 }, (_, index) => index);
    const proofs = [];
    const transport = new BleTransport({});
    transport.characteristics.set(256, { readValue: async () => new DataView(nonce.slice().buffer) });
    transport.characteristics.set(257, { async writeValueWithResponse(bytes) { proofs.push(Buffer.from(bytes)); } });
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    await transport.setControlKey(key);
    assert.ok(key.every(byte => byte === 0), "the caller's key bytes are wiped");
    const uid = Buffer.from("0001020304050607", "hex");
    const signal = new AbortController().signal;
    await transport.prove(uid, Buffer.from("SESSION01"), signal);
    await transport.prove(uid, Buffer.from("010702010000000000", "hex"), signal);
    assert.deepEqual(proofs.map(proof => proof.toString("hex")),
      ["7c583e03087e013dc444f219fa69cfe4", "c090cfe4b5d641b4dd4f8d710c7dad6d"]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "crypto", previous);
    else delete globalThis.crypto;
  }
});
