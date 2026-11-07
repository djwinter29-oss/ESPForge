import test from "node:test";
import assert from "node:assert/strict";
import {demoStatus, validateStatus, validateWifi, requestLine} from "../protocol.js";
import {SerialTransport, BleTransport, BridgeTransport, DemoTransport} from "../transports.js";

test("status shape requires real typed protocol fields", () => {
  assert.equal(validateStatus(demoStatus()).protocol, 1);
  for (const mutation of [{protocol: 2}, {product: "Other"}, {sd_mounted: "false"}, {uptime_ms: -1}, {wifi_error: NaN}]) {
    assert.throws(() => validateStatus({...demoStatus(), ...mutation}));
  }
  const incomplete = demoStatus();
  delete incomplete.ble_error;
  assert.throws(() => validateStatus(incomplete));
});

test("credential boundaries use UTF-8 bytes and allow open networks", () => {
  validateWifi({ssid: "a".repeat(32), psk: "a".repeat(63)});
  validateWifi({ssid: "lab", psk: ""});
  assert.throws(() => validateWifi({ssid: "a".repeat(33), psk: ""}));
  assert.throws(() => validateWifi({ssid: "\u00e9".repeat(17), psk: ""}));
  assert.throws(() => validateWifi({ssid: "lab", psk: "short"}));
  assert.throws(() => validateWifi({ssid: "lab\0", psk: ""}));
});

test("wire credentials round-trip Unicode, quote and backslash without JSON escapes", () => {
  const fields = {ssid: 'lab"\u00e9', psk: 'pass\\word'};
  const line = requestLine(2, "wifi.connect", fields);
  const value = JSON.parse(line);
  assert.equal(Buffer.from(value.ssid_hex, "hex").toString("utf8"), fields.ssid);
  assert.equal(Buffer.from(value.psk_hex, "hex").toString("utf8"), fields.psk);
  assert.equal(value.id, 2);
  assert.equal(value.ssid, undefined);
  assert.ok(new TextEncoder().encode(line).length <= 512);
  assert.ok(line.endsWith("\n"));
  assert.throws(() => requestLine(1, "status", {padding: "x".repeat(512)}));
});

test("Web Serial handles fragmented replies, ROM messages and stale IDs", async () => {
  const transport = new SerialTransport();
  const encoder = new TextEncoder();
  let count = 0;
  const chunks = ['ESP-ROM boot\n{"id":99,"ok":true}\n{"id":1,', '"ok":true,"status":', JSON.stringify(demoStatus()) + "}\n"];
  transport.reader = {
    async read() {
      if (count < chunks.length) return {value: encoder.encode(chunks[count++]), done: false};
      return {done: true};
    },
    releaseLock() {},
  };
  transport.writer = {async write() {}};
  const response = transport.status();
  await transport.readLoop();
  assert.equal((await response).product, "ESPForge");
});

test("Web Serial surfaces malformed JSON and device frame rejection", async () => {
  for (const text of ['{bad}\n', '{"id":0,"ok":false,"error":-90}\n']) {
    const transport = new SerialTransport();
    transport.reader = {async read() { return {value: new TextEncoder().encode(text), done: false}; }, releaseLock() {}};
    transport.writer = {async write() {}};
    const response = transport.status();
    const rejected = assert.rejects(response);
    await transport.readLoop();
    await rejected;
  }
});

test("Web Serial closes safely after its read loop fails", async () => {
  const transport = new SerialTransport();
  let closed = 0;
  transport.opened = true;
  transport.port = {async close() { closed++; }};
  transport.reader = {
    async read() { throw new Error("Unplugged"); },
    releaseLock() {},
    async cancel() { throw new Error("Already released reader"); },
  };
  transport.writer = {releaseLock() {}};
  transport.readTask = transport.readLoop();
  await transport.readTask;
  await transport.close();
  await transport.close();
  assert.equal(closed, 1);
});

test("failed serial open is not treated as an open port during cleanup", async () => {
  const transport = new SerialTransport();
  transport.port = {async close() { assert.fail("Port was not opened"); }};
  await transport.close();
});

test("transport capabilities explicitly distinguish simulation and read-only BLE", async () => {
  assert.equal(new SerialTransport().simulated, false);
  assert.equal(new BleTransport().writable, false);
  assert.equal(new BleTransport().simulated, false);
  const demo = new DemoTransport();
  assert.equal(demo.simulated, true);
  assert.equal(demo.writable, false);
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ok: true, json: async () => ({name: "Python", demo: true})});
    const bridge = new BridgeTransport();
    await bridge.connect();
    assert.equal(bridge.simulated, true);
    assert.equal(bridge.writable, false);
  } finally { globalThis.fetch = oldFetch; }
});
