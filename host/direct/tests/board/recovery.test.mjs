// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { OP } from "../../web/js/protocol/constants.mjs";
import { describe } from "../../web/js/ui/messages.mjs";
import { BoardSession } from "../../web/js/board/session.mjs";
import { HidTransport } from "../../web/js/transport/hid.mjs";
import {
  telemetry, storage, result, fakeConnection, emit, attachDevice, says,
} from "../support/fixtures.mjs";
import { connected, radio } from "../support/wireless.mjs";

test("disconnect during GET clears caches and reconnect resolves only the original result, without SET replay", async () => {
  const { client, device, hid, sent } = fakeConnection();
  await client.connect();
  emit(device, 3, telemetry());
  let release;
  const normalRead = device.receiveFeatureReport;
  device.receiveFeatureReport = id => id === 20 ? new Promise(resolve => { release = resolve; }) : normalRead(id);
  const command = client.command(OP.SCAN);
  await new Promise(resolve => setImmediate(resolve));
  hid.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
  assert.equal(client.state.hardware, null);
  assert.equal(client.state.outcome_uncertain, true);
  device.receiveFeatureReport = normalRead;
  await attachDevice(client, device);
  assert.equal(client.state.connected, true);
  assert.equal(client.state.runtime, null);
  assert.equal(client.state.outcome_uncertain, false);
  release(result(sent[0][2], OP.SCAN));
  await assert.rejects(command, says(/disconnect/));
  assert.equal(client.state.error, null, "old request must not overwrite the reconnected state");
  assert.equal(sent.length, 1);
  await client.disconnect();
});

test("pending control transactions survive a page reload and reconcile without replay", async () => {
  const { client, device, hid, sent, pendingStore } = fakeConnection();
  await client.connect();
  emit(device, 3, telemetry());
  const receive = device.receiveFeatureReport;
  device.receiveFeatureReport = async id => {
    if (id === 20) {
      hid.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
      device.opened = false;
      throw new Error("USB disconnected");
    }
    return receive(id);
  };
  await assert.rejects(client.command(OP.SCAN), says(/disconnect/));
  const saved = JSON.parse(pendingStore.getItem("espforge.direct.pending-operation"));
  assert.equal(saved.kind, "control");
  assert.equal(saved.uid, client.connection.reconnectUid);

  device.receiveFeatureReport = receive;
  const restored = new BoardSession(new HidTransport(hid), { sleep: async () => {}, pendingStore });
  await attachDevice(restored, device);
  assert.equal(restored.state.outcome_uncertain, false);
  assert.match(describe(restored.state.recovery_message), /confirmed after reconnect/);
  assert.equal(restored.state.recovered_opcode, OP.SCAN, "the form keys recovery on the opcode, not the text");
  assert.equal(pendingStore.getItem("espforge.direct.pending-operation"), null);
  assert.equal(sent.length, 1, "recovery reads the result and never resends the command");
  await restored.disconnect();
});

test("a settings save interrupted by re-enumeration reconnects to the original result without replay", async () => {
  for (const incorrect of [false, true]) {
    const { client, device, hid, sent } = fakeConnection({
      sleep: async () => new Promise(resolve => setTimeout(resolve, 1)) });
    await client.connect();
    emit(device, 10, storage());
    const receive = device.receiveFeatureReport;
    let detached = false;
    device.receiveFeatureReport = async id => {
      if (id === 20 && !detached) {
        detached = true;
        hid.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
        device.opened = false;
        setTimeout(() => hid.dispatchEvent(Object.assign(new Event("connect"), { device })), 1);
        throw new Error("USB disconnected during save");
      }
      const response = await receive(id);
      if (incorrect && id === 20) response[5] = 80;
      return response;
    };
    await assert.rejects(client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 0, radios: 0 }),
      says(/disconnect/));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(client.state.connected, true);
    if (incorrect) assert.match(describe(client.state.error), /did not confirm/);
    else assert.match(describe(client.state.recovery_message), /confirmed after reconnect/);
    assert.deepEqual(sent, [[20, 1, 1, 5, 0, 160, 0, 0, 0, ...Array(60).fill(0)]]);
    assert.equal(client.state.outcome_uncertain, incorrect);
    if (incorrect) {
      await assert.rejects(client.command(OP.SCAN), says(/uncertain/));
    }
    await client.disconnect();
  }
});

test("uncertain command recovery stores no secrets, reads same UID+tx+opcode and never replays SET", async () => {
  const setup = await connected(); radio(setup);
  const read = setup.device.receiveFeatureReport;
  let fail = true;
  setup.device.receiveFeatureReport = async id => {
    if (id === 20 && fail) throw new Error("USB disconnected");
    return read(id);
  };
  await assert.rejects(setup.client.testWireless({ ssid: "secret-network", password: "secret-password" }),
    says(/disconnected/));
  const raw = setup.pendingStore.getItem("espforge.direct.pending-operation");
  assert.ok(raw);
  assert.equal(raw.includes("secret"), false);
  const record = JSON.parse(raw);
  assert.deepEqual(record.request, { transaction_id: 1, opcode: 6 });
  fail = false;
  const restored = new BoardSession(new HidTransport(setup.hid),
    { pendingStore: setup.pendingStore, wirelessPolling: false });
  await attachDevice(restored, setup.device);
  assert.equal(restored.state.outcome_uncertain, false);
  assert.equal(setup.sent.length, 1);
  await restored.disconnect(); await setup.client.disconnect();
});

test("accepted test lifecycle survives reload, enforces generation and never stores pair bytes", async () => {
  for (const wrongGeneration of [false, true]) {
    const setup = await connected(); radio(setup);
    const read = setup.device.receiveFeatureReport;
    let interrupt = true;
    setup.device.receiveFeatureReport = async id => {
      if (id === 12 && setup.sent.some(bytes => bytes[3] === 9) && interrupt) throw new Error("Link lost");
      const bytes = await read(id);
      if (id === 12 && wrongGeneration) bytes[46] = 2;
      return bytes;
    };
    await assert.rejects(setup.client.testWireless({ ssid: "home", password: "password" }), says(/Link lost/));
    const raw = setup.pendingStore.getItem("espforge.direct.pending-operation");
    assert.equal(raw.includes("password"), false);
    assert.equal(JSON.parse(raw).kind, "wireless-lifecycle");
    interrupt = false;
    const restored = new BoardSession(new HidTransport(setup.hid),
      { pendingStore: setup.pendingStore, wirelessPolling: false });
    await attachDevice(restored, setup.device);
    assert.equal(restored.state.outcome_uncertain, wrongGeneration);
    assert.equal(setup.sent.length, 3);
    await restored.disconnect(); await setup.client.disconnect();
  }
});
