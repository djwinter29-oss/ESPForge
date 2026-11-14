// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { CAP, OP } from "../../web/js/protocol/constants.mjs";
import { describe } from "../../web/js/ui/messages.mjs";
import { BoardSession } from "../../web/js/board/session.mjs";
import {
  telemetry, storage, result, fakeConnection, emit, attachDevice, says, patchState,
} from "../support/fixtures.mjs";
import { lifecycleOutcome, ReportReceipts, wirelessPollInterval } from "../../web/js/board/polling.mjs";
import { REASON } from "../../web/js/state/errors.mjs";
import { BleTransport } from "../../web/js/transport/ble.mjs";
import { status, connected } from "../support/wireless.mjs";

test("freshness is independent, exact at deadlines, and clears caches on disconnect/reconnect", async () => {
  let now = 0;
  const { client, device, hid } = fakeConnection({ now: () => now });
  await client.connect();
  assert.equal(client.state.freshness[3], "unavailable");
  emit(device, 3, telemetry()); emit(device, 10, storage());
  assert.equal(client.state.freshness[11], "unavailable", "benchmark is unavailable without its capability");
  assert.ok(client.polling.receipts.timer, "fresh reports schedule the next expiry instead of polling");
  now = 749; client.expireReports();
  assert.ok(client.state.runtime);
  now = 750; client.expireReports();
  assert.equal(client.state.runtime, null);
  assert.equal(client.state.freshness[3], "stale");
  assert.ok(client.state.memory);
  now = 1499; client.expireReports();
  assert.ok(client.state.memory);
  now = 1500; client.expireReports();
  assert.equal(client.state.memory, null);
  assert.equal(client.state.freshness[10], "stale");
  emit(device, 3, telemetry());
  assert.equal(client.state.freshness[3], "fresh");
  const invalid = telemetry(); invalid[0] = 2;
  now = 2000; emit(device, 3, invalid);
  now = 2250; client.expireReports();
  assert.equal(client.state.runtime, null, "invalid reports never refresh receipt time");
  emit(device, 3, telemetry()); client.expireReports(true);
  assert.equal(client.state.runtime, null);
  hid.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
  assert.equal(client.polling.receipts.timer, null);
  for (const field of ["hardware", "settings", "runtime", "memory"]) {
    assert.equal(client.state[field], null, field);
  }
  await attachDevice(client, device);
  assert.equal(client.state.freshness[10], "unavailable");
  assert.equal(client.state.memory, null);
  await client.disconnect();
});

test("Report12 freshness uses active500ms/idle2s and invalid reads never refresh the receipt", async () => {
  let now = 0;
  const setup = fakeConnection({ now: () => now });
  await setup.client.connect();
  let current = status();
  const read = setup.device.receiveFeatureReport;
  setup.device.receiveFeatureReport = async id => id === 12 ? current : read(id);
  await setup.client.readWireless();
  now = 5999; setup.client.expireReports(); assert.ok(setup.client.state.wireless);
  now = 6000; setup.client.expireReports(); assert.equal(setup.client.state.wireless, null);
  current = status({ state: 4, flags: 48, testGeneration: 1 });
  await setup.client.readWireless();
  assert.equal(wirelessPollInterval(setup.client.state.wireless), 500);
  current = new Uint8Array(53);
  now = 7499; await assert.rejects(setup.client.readWireless());
  setup.client.expireReports(); assert.ok(setup.client.state.wireless);
  now = 7500; setup.client.expireReports(); assert.equal(setup.client.state.wireless, null);
  await setup.client.disconnect();
});

test("slow BLE polling keeps valid snapshots visible but still expires missing and invalid reports", async () => {
  const setup = await connected();
  const transport = new BleTransport({});
  let now = 0;
  const client = new BoardSession(transport, { pendingStore: setup.pendingStore, now: () => now,
    wirelessPolling: false });
  patchState(client, { ...setup.client.state, link: "ble",
    hardware: { ...setup.client.state.hardware, capabilities: setup.client.state.hardware.capabilities | CAP.SELF_TEST } });
  setup.client.dispose();
  transport.device = Object.assign(new EventTarget(), { gatt: { connected: true, disconnect() {} } });
  const benchmark = new Uint8Array(32); benchmark[0] = 1;
  const reports = { 3: telemetry(), 10: storage(), 11: benchmark };
  for (const [id, bytes] of Object.entries(reports)) {
    transport.characteristics.set(Number(id), { async readValue() {
      now += 400;
      client.expireReports();
      return new DataView(bytes.buffer);
    } });
    client.polling.onInputReport({ reportId: Number(id), data: bytes });
  }
  let blanks = 0;
  const unsubscribe = client.store.subscribe(() => {
    if (!client.state.runtime || !client.state.memory || !client.state.self_test) blanks++;
  });
  try {
    for (let round = 0; round < 3; round++) {
      await client.polling.pollReports();
      client.timers.clearTimeout(client.polling.pollTimer);
      now += transport.pollInterval;
      client.expireReports();
    }
    assert.equal(blanks, 0, "valid slow GATT rounds must not blank live values between reads");
    unsubscribe();
    const telemetryReceived = client.polling.receipts.get(3);
    const storageReceived = client.polling.receipts.get(10);
    const benchmarkReceived = client.polling.receipts.get(11);
    now = telemetryReceived + 2999;
    const invalid = telemetry(); invalid[0] = 2;
    client.polling.onInputReport({ reportId: 3, data: invalid });
    client.expireReports();
    assert.ok(client.state.runtime);
    now++;
    client.expireReports();
    assert.equal(client.state.runtime, null, "an invalid report must not extend the BLE freshness window");
    assert.equal(client.state.freshness[3], "stale");
    now = storageReceived + 5999;
    client.expireReports();
    assert.ok(client.state.memory);
    now++;
    client.expireReports();
    assert.equal(client.state.memory, null);
    now = benchmarkReceived + 6000;
    client.expireReports();
    assert.equal(client.state.self_test, null);
    for (const [id, bytes] of Object.entries(reports))
      client.polling.onInputReport({ reportId: Number(id), data: bytes });
    await client.disconnect();
    assert.equal(client.state.runtime, null);
    assert.equal(client.state.memory, null);
  } finally { unsubscribe(); client.dispose(); }
});

test("delayed BLE status reads preserve command matching and never replay a rejected GATT write", async () => {
  const setup = await connected();
  const transport = new BleTransport({});
  const client = new BoardSession(transport, { pendingStore: setup.pendingStore, wirelessPolling: false,
    now: () => 2000 });
  patchState(client, { ...setup.client.state, link: "ble" });
  setup.client.dispose();
  const device = Object.assign(new EventTarget(), { gatt: { connected: true, disconnect() {} } });
  transport.device = device;
  const proofs = [];
  transport.uid = "0102030405060708";
  transport.prove = async (uid, request) => { proofs.push([...request]); };
  const reboot = async () => {
    await client.command(OP.REBOOT, { flags: 1 });
    patchState(client, { reboot_pending: false });
  };
  client.polling.onInputReport({ reportId: 3, data: telemetry() });
  const reports = { 3: telemetry(), 10: storage(), 12: status() };
  let releaseTelemetry, releaseWireless;
  let telemetryPending = true, wirelessPending = true, rejectWrite = false;
  let wirelessReads = 0;
  const writes = [];
  for (const id of [3, 10, 12, 20]) {
    transport.characteristics.set(id, {
      async readValue() {
        if (id === 3 && telemetryPending) {
          await new Promise(resolve => { releaseTelemetry = resolve; });
          telemetryPending = false;
        }
        if (id === 12) {
          wirelessReads++;
          if (wirelessPending) await new Promise(resolve => { releaseWireless = resolve; });
        }
        const request = writes.at(-1);
        const bytes = id === 20 ? result(request[1], request[2]).slice(0, 9) : reports[id];
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },
      async writeValueWithResponse(request) {
        if (rejectWrite) throw new DOMException("GATT operation already in progress", "NetworkError");
        writes.push([...request]);
      },
    });
  }
  try {
    const poll = client.polling.pollReports();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseTelemetry, "function");
    const rebooting = reboot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 0, "a command waits for the current native GATT read");
    releaseTelemetry();
    await rebooting;
    await poll;
    assert.equal(writes.length, 1, "an overlapping status read cannot consume a command result");
    assert.deepEqual(proofs, [writes[0]], "every Bluetooth command is proved");
    rejectWrite = true;
    await assert.rejects(client.command(OP.REBOOT, { flags: 1 }), { code: REASON.BLE_PROOF_REJECTED });
    assert.equal(client.state.pending_request, null, "a native SET rejection is authoritative");
    assert.equal(client.state.outcome_uncertain, false);
    assert.equal(client.state.freshness[3], "fresh");
    assert.equal(writes.length, 1, "the rejected write is not retried when the status read finishes");
    rejectWrite = false;
    await reboot();
    assert.equal(writes.length, 2, "only an explicit later action sends another write");
    client.polling.enabled = true;
    client.pollWireless();
    client.pollWireless();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wirelessReads, 1, "Feature 12 has one in-flight background reader");
    client.connection.clear();
    wirelessPending = false;
    releaseWireless();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.state.wireless, null, "late BLE status cannot restore a disconnected snapshot");
    assert.equal(writes.length, 2);
  } finally { client.dispose(); }
});

test("a BLE command that times out behind a status read must never write later", async () => {
  const setup = await connected();
  const transport = new BleTransport({});
  const client = new BoardSession(transport, { pendingStore: setup.pendingStore, timeout: 10,
    wirelessPolling: false, now: () => 2000 });
  patchState(client, { ...setup.client.state, link: "ble" });
  setup.client.dispose();
  transport.device = Object.assign(new EventTarget(), { gatt: { connected: true, disconnect() {} } });
  transport.uid = "0102030405060708";
  let release, proofs = 0, writes = 0;
  transport.prove = async () => { proofs++; };
  transport.characteristics.set(3, { async readValue() {
    await new Promise(resolve => { release = resolve; });
    return telemetry();
  } });
  transport.characteristics.set(20, { async writeValueWithResponse() { writes++; } });
  const read = transport.readReport(3, client.connectionSignal);
  try {
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(client.command(OP.REBOOT, { flags: 1 }), { name: "TimeoutError" });
    assert.equal(client.state.outcome_uncertain, true);
    release();
    await read;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proofs, 0, "a timed-out queued command must not consume a challenge");
    assert.equal(writes, 0, "unblocking the GATT queue must not send an expired command");
    assert.ok(client.state.pending_request, "uncertain state still requires explicit reconciliation");
  } finally { release?.(); client.dispose(); }
});

test("lifecycleOutcome reads one Feature 12 snapshot against the accepted generation", () => {
  const scan = { operation: OP.SCAN, generation: 4 };
  assert.equal(lifecycleOutcome({ scan_generation: 4, scan_state: 1 }, scan), null);
  assert.equal(lifecycleOutcome({ scan_generation: 4, scan_state: 2 }, scan).kind, "completed");
  const failed = lifecycleOutcome({ scan_generation: 4, scan_state: 3 }, scan);
  assert.deepEqual([failed.kind, describe(failed.error)], ["failed", "Wireless scan failed"]);
  assert.throws(() => lifecycleOutcome({ scan_generation: 5, scan_state: 2 }, scan), says(/generation changed/));
  const wifiTest = { operation: OP.TEST_WIFI, generation: 2 };
  assert.equal(lifecycleOutcome({ test_generation: 2, state: 5, pair_tested: true }, wifiTest).result
    .remaining_seconds, 599);
  assert.ok(says(/^Password rejected$/)(lifecycleOutcome({ test_generation: 2, state: 6, detail: 3 }, wifiTest).error));
});

test("report receipts expire each snapshot after its own lifetime and on suspend", () => {
  let now = 0;
  const receipts = new ReportReceipts(globalThis, () => now, () => null);
  receipts.record(3);
  receipts.record(10);
  now = 800;
  assert.deepEqual(receipts.expire({ 3: "fresh", 10: "fresh" }),
    { runtime: null, freshness: { 3: "stale", 10: "fresh" } });
  assert.equal(receipts.expire({ 10: "fresh" }), null, "storage outlives telemetry");
  assert.equal(receipts.expire({ 10: "fresh" }, true).freshness[10], "stale", "suspend expires everything");
  assert.equal(receipts.size, 0);
});
