// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { commandPending } from "../../web/js/state/selectors.mjs";
import { OP } from "../../web/js/protocol/constants.mjs";
import { describe } from "../../web/js/ui/messages.mjs";
import { BoardSession } from "../../web/js/board/session.mjs";
import { HidTransport } from "../../web/js/transport/hid.mjs";
import { telemetry, storage, result, fakeConnection, emit, says } from "../support/fixtures.mjs";
import { BOARD, connected, radio } from "../support/wireless.mjs";

/** @brief A plain USB write with no arguments and no reboot. */
const scan = (client, options) => client.command(OP.SCAN, options);

test("unavailable recovery storage fails closed and keeps its error visible across disconnect", () => {
  const unavailable = new BoardSession(new HidTransport(null), { pendingStore: null });
  assert.equal(unavailable.state.outcome_uncertain, true);
  assert.match(describe(unavailable.state.error), /session storage is unavailable/);
  unavailable.connection.clear();
  assert.equal(unavailable.state.outcome_uncertain, true);
  assert.match(describe(unavailable.state.error), /session storage is unavailable/);
});

test("malformed saved operation records fail closed and cannot authorize a write", async () => {
  const { device, hid, sent, pendingStore } = fakeConnection();
  pendingStore.setItem("espforge.direct.pending-operation", JSON.stringify({
    version: 1, kind: "control", uid: "0102030405060708",
    request: { transaction_id: 1, opcode: OP.SCAN }, password: "unexpected",
  }));
  const client = new BoardSession(new HidTransport(hid), { sleep: async () => {}, pendingStore });
  assert.match(describe(client.state.error), /invalid/);
  await client.connect();
  emit(device, 3, telemetry());
  await assert.rejects(scan(client), says(/unavailable/));
  assert.equal(sent.length, 0);
});

test("transactions serialize, match ID and opcode, poll Pending, wrap IDs, and do not mutate telemetry", async () => {
  const { client, device, sent } = fakeConnection();
  await client.connect(); emit(device, 3, telemetry());
  let calls = 0;
  const original = device.receiveFeatureReport;
  device.receiveFeatureReport = async id => {
    if (id !== 20) return original(id);
    calls++;
    const [transaction, opcode] = sent.at(-1).slice(2, 4);
    if (calls === 1) return result(transaction, OP.REBOOT);
    if (calls === 2) return result(255, opcode);
    return result(transaction, opcode, calls === 3 ? 1 : 2);
  };
  client.commands.transaction = 255;
  const pending = scan(client);
  await assert.rejects(scan(client), says(/unavailable/));
  await pending;
  assert.deepEqual(sent[0], [20, 1, 1, OP.SCAN, ...Array(65).fill(0)]);
  assert.equal(calls, 4);
  await client.disconnect();
});

test("SET failure never polls; terminal rejection permits a new transaction; timeout blocks replay", async () => {
  const { client, device, reads } = fakeConnection();
  await client.connect(); emit(device, 3, telemetry());
  device.sendFeatureReport = async () => { throw new Error("SET rejected"); };
  await assert.rejects(scan(client), says(/SET rejected/));
  assert.deepEqual(reads, [1, 2]);
  assert.equal(client.state.outcome_uncertain, false);
  let request;
  device.sendFeatureReport = async (id, payload) => { request = payload; };
  device.receiveFeatureReport = async () => result(request[1], request[2], 6, 6);
  await assert.rejects(scan(client), says(/status 6, error 6/));
  assert.equal(client.state.outcome_uncertain, false);
  device.receiveFeatureReport = async () => result(request[1], request[2]);
  await assert.doesNotReject(scan(client));
  const timeout = fakeConnection({ sleep: async () => {}, timeout: 10000 });
  await timeout.client.connect(); emit(timeout.device, 3, telemetry());
  timeout.device.receiveFeatureReport = async () => result(0, 0, 0);
  await assert.rejects(timeout.client.command(OP.SCAN), says(/uncertain/));
  await assert.rejects(timeout.client.command(OP.SCAN), says(/uncertain/));
  assert.equal(timeout.sent.length, 1);
  await timeout.client.disconnect();
  await client.disconnect();
});

test("hanging SET/GET requests time out as uncertain and never replay", async () => {
  for (const operation of ["sendFeatureReport", "receiveFeatureReport"]) {
    const { client, device, sent } = fakeConnection({ timeout: 10 });
    await client.connect(); emit(device, 3, telemetry());
    device[operation] = () => new Promise(() => {});
    await assert.rejects(scan(client), says(/timeout/));
    assert.equal(client.state.outcome_uncertain, true);
    await assert.rejects(scan(client), says(/uncertain/));
    assert.equal(sent.length, operation === "sendFeatureReport" ? 0 : 1);
    await client.disconnect();
  }
});

test("settings completion remains serialized and verifies saved values without a config read", async () => {
  const { client, device, sent } = fakeConnection();
  await client.connect();
  emit(device, 3, telemetry()); emit(device, 10, storage());
  const normalRead = device.receiveFeatureReport;
  let release;
  device.receiveFeatureReport = id => id === 20 ? new Promise(resolve => { release = resolve; }) : normalRead(id);
  const saving = client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 0, radios: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.state.busy, true);
  await assert.rejects(scan(client), says(/unavailable/));
  const incorrect = result(1, 5); incorrect[5] = 80;
  release(incorrect);
  await assert.rejects(saving, says(/did not confirm/));
  assert.equal(sent.length, 1);
  assert.equal(client.state.settings.system_clock_mhz, 240);
  await client.disconnect();
});

test("normal and commit saves keep writes blocked when returned settings differ without disconnect", async () => {
  for (const flags of [0, 2]) {
    const { client, device, sent } = fakeConnection();
    await client.connect();
    const receive = device.receiveFeatureReport;
    device.receiveFeatureReport = async id => {
      const response = await receive(id);
      if (id === 20) response[5] = 80;
      return response;
    };
    await assert.rejects(client.command(5, { flags, args: [160, 0, 0, 0] }), says(/did not confirm/));
    assert.equal(client.state.outcome_uncertain, true);
    await assert.rejects(scan(client), says(/uncertain/));
    assert.equal(sent.length, 1);
    await client.disconnect();
  }
});

test("cancelling an in-flight write preserves uncertainty and its recovery journal", async () => {
  const { client, device, sent, pendingStore } = fakeConnection();
  let release;
  device.sendFeatureReport = async (id, report) => {
    sent.push([id, ...report]);
    await new Promise(resolve => { release = resolve; });
  };
  await client.connect();
  const controller = new AbortController();
  const command = scan(client, { signal: controller.signal });
  assert.equal(commandPending(client.state), true);
  controller.abort();
  await assert.rejects(command, { name: "AbortError" });
  assert.equal(client.state.outcome_uncertain, true);
  assert.ok(client.state.pending_request);
  assert.ok(pendingStore.getItem("espforge.direct.pending-operation"));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1, "late completion never replays the write or clears its uncertainty");
  assert.equal(client.state.outcome_uncertain, true);
  await client.disconnect();
  client.dispose();
});

test("save commit-mask mismatch is uncertain even after firmware clears staged state", async () => {
  const setup = await connected(); radio(setup);
  const read = setup.device.receiveFeatureReport;
  setup.device.receiveFeatureReport = async id => {
    const bytes = await read(id);
    if (id === 20 && bytes[2] === 5) bytes[9] = 0;
    return bytes;
  };
  await assert.rejects(setup.client.saveWireless({ ssid: "", password: "", wifi_enabled: false,
    ble_enabled: false, board: BOARD }), says(/did not confirm/));
  assert.equal(setup.client.state.outcome_uncertain, true);
  await assert.rejects(scan(setup.client), says(/uncertain/));
  assert.equal(JSON.parse(setup.pendingStore.getItem("espforge.direct.pending-operation")).request.commit_mask, 3);
  await setup.client.disconnect();
});

test("scan result index/generation mismatch keeps the original query persisted and blocks further writes", async () => {
  const setup = await connected();
  radio(setup, { scanEntries: [Uint8Array.of(65)] });
  const read = setup.device.receiveFeatureReport;
  setup.device.receiveFeatureReport = async id => {
    const bytes = await read(id);
    if (id === 20 && bytes[2] === 12) bytes[5] = 2;
    return bytes;
  };
  await assert.rejects(setup.client.scanWireless(), says(/generation and index/));
  assert.equal(setup.client.state.outcome_uncertain, true);
  const request = JSON.parse(setup.pendingStore.getItem("espforge.direct.pending-operation")).request;
  assert.equal(request.scan_generation, 1); assert.equal(request.scan_index, 0);
  await setup.client.disconnect();
});
