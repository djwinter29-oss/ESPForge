// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { config, telemetry, storage, fakeConnection, emit, says } from "../support/fixtures.mjs";
import { Operations } from "../../web/js/board/operations.mjs";
import { BOARD, connected, radio } from "../support/wireless.mjs";

test("LED commands use reported colour, ignore SD readiness and never replay uncertain writes", async () => {
  const { client, device, sent, pendingStore } = fakeConnection({ capabilities: 0x97 });
  await client.connect();
  const status = telemetry(); status[21] |= 8;
  emit(device, 3, status);
  await client.setLedColour(4);
  assert.deepEqual(sent[0].slice(0, 6), [20, 1, 1, 1, 0, 4]);
  assert.equal(client.state.runtime, null);
  await assert.rejects(client.setLedColour(2));
  const receive = device.receiveFeatureReport;
  device.receiveFeatureReport = async id => {
    if (id === 20) throw new Error("lost LED acknowledgement");
    return receive(id);
  };
  emit(device, 3, status);
  await assert.rejects(client.setLedColour(6));
  assert.equal(client.state.outcome_uncertain, true);
  assert.equal(JSON.parse(pendingStore.getItem("espforge.direct.pending-operation")).request.led_colour, 6);
  device.receiveFeatureReport = receive;
  await client.disconnect();
  await client.connect();
  assert.equal(sent.length, 2, "Re-sync reads the original result without replay");
  assert.equal(client.state.runtime, null);
  await client.disconnect();
});

test("benchmark admission invalidates snapshots and uncertain starts are never replayed", async () => {
  const { client, device, sent, pendingStore } = fakeConnection({ capabilities: 0xb6 });
  await client.connect();
  const idle = new Uint8Array(32); idle[0] = 1;
  emit(device, 10, storage()); emit(device, 11, idle);
  await assert.rejects(client.benchmark(true, 8, false));
  assert.equal(sent.length, 0);
  await client.benchmark(true, 8, true);
  assert.deepEqual(sent[0].slice(0, 10), [20, 1, 1, 4, 0, 1, 8, 0, 0, 0]);
  assert.equal(client.state.self_test, null);
  assert.equal(client.state.memory, null);
  const active = idle.slice(); active[2] = 3;
  new DataView(active.buffer).setUint32(4, 8 * 1024 ** 2, true);
  const busy = new Uint8Array(34); busy[0] = busy[2] = 1;
  emit(device, 10, busy); emit(device, 11, active);
  await client.benchmark(false, 0, false);
  assert.deepEqual(sent[1].slice(0, 10), [20, 1, 2, 4, 0, 0, 0, 0, 0, 0]);
  emit(device, 10, storage()); emit(device, 11, idle);
  const receive = device.receiveFeatureReport;
  device.receiveFeatureReport = async id => {
    if (id === 20) throw new Error("Benchmark result lost");
    return receive(id);
  };
  await assert.rejects(client.benchmark(true, 8, true));
  const pending = JSON.parse(pendingStore.getItem("espforge.direct.pending-operation"));
  assert.deepEqual(pending.request, { transaction_id: 3, opcode: 4,
    benchmark_start: true, benchmark_size_mib: 8 });
  await assert.rejects(client.benchmark(true, 8, true));
  assert.equal(sent.length, 3);
  await client.disconnect();
});

test("MSC admission clears old storage facts, requires eject confirmation, and never replays uncertain writes", async () => {
  const { client, device, sent, pendingStore } = fakeConnection();
  const receive = device.receiveFeatureReport;
  device.receiveFeatureReport = async id => {
    if (id !== 2) return receive(id);
    const report = config(); report[13] = 0x45; report[16] = 8;
    return report;
  };
  await client.connect();
  emit(device, 10, storage());
  await client.setMsc(true);
  assert.deepEqual(sent[0].slice(0, 6), [20, 1, 1, 3, 0, 1]);
  assert.equal(client.state.memory, null);
  await assert.rejects(client.reboot(true), says(/Fresh storage status/));
  const owned = new Uint8Array(34);
  owned[0] = owned[2] = owned[31] = 1;
  emit(device, 10, owned);
  await assert.rejects(client.setMsc(false), says(/Invalid/));
  assert.equal(sent.length, 1);
  await client.setMsc(true);
  emit(device, 10, owned);
  await client.setMsc(false, true);
  assert.deepEqual(sent[2].slice(0, 6), [20, 1, 3, 3, 1, 0]);
  emit(device, 10, storage());
  device.receiveFeatureReport = async id => {
    if (id === 20) throw new Error("Result lost");
    return receive(id);
  };
  await assert.rejects(client.setMsc(true));
  const pending = JSON.parse(pendingStore.getItem("espforge.direct.pending-operation"));
  assert.deepEqual(pending.request, { transaction_id: 4, opcode: 3, msc_enabled: true });
  await assert.rejects(client.setMsc(true));
  assert.equal(sent.length, 4);
  await client.disconnect();
});

test("stale storage and capability gates stop reboot and settings writes", async () => {
  let now = 0;
  const { client, device, sent } = fakeConnection({ now: () => now, capabilities: 16 | 128 });
  await client.connect();
  await assert.rejects(client.reboot(true), says(/Fresh storage status/));
  emit(device, 3, telemetry()); emit(device, 10, storage());
  await assert.rejects(client.reboot(true), says(/capability/));
  await assert.rejects(client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 0, radios: 0 }), says(/capability/));
  await client.disconnect();
  const stale = fakeConnection({ now: () => now });
  await stale.client.connect();
  emit(stale.device, 10, storage());
  now = 5000;
  await assert.rejects(stale.client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 0, radios: 0 }),
    says(/Fresh storage status/));
  assert.equal(sent.length + stale.sent.length, 0);
  await stale.client.disconnect();
});

test("settings save sends ESPForge clocks and switch bits and verifies them", async () => {
  const { client, device, sent } = fakeConnection();
  await client.connect();
  emit(device, 10, storage());
  await assert.rejects(client.saveSettings({ system_clock_mhz: 200, sdcard_profile: 0, radios: 0 }), says(/Invalid/));
  await assert.rejects(client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 1, radios: 0 }), says(/Invalid/));
  await assert.rejects(client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 0, radios: 4 }), says(/Invalid/));
  assert.equal(sent.length, 0);
  await client.saveSettings({ system_clock_mhz: 80, sdcard_profile: 0, radios: 2 });
  assert.deepEqual(sent[0], [20, 1, 1, 5, 0, 80, 0, 0, 2, ...Array(60).fill(0)]);
  assert.equal(client.state.settings.radios, 2);
  await client.disconnect();
});

test("settings save queues the firmware reboot and a confirmed reboot is a single opcode", async () => {
  const { client, device, sent } = fakeConnection();
  await client.connect();
  emit(device, 10, storage());
  await client.saveSettings({ system_clock_mhz: 160, sdcard_profile: 0, radios: 0 });
  assert.deepEqual(sent[0], [20, 1, 1, 5, 0, 160, 0, 0, 0, ...Array(60).fill(0)]);
  assert.equal(sent.length, 1, "firmware reboot requires no second command");
  assert.equal(client.state.reboot_pending, true);
  await client.disconnect();
  await client.connect();
  emit(device, 10, storage());
  await assert.rejects(client.reboot(false), says(/confirmation/));
  await client.reboot(true);
  assert.deepEqual(sent[1].slice(0, 5), [20, 1, 2, 2, 1]);
  assert.equal(client.state.reboot_pending, true);
  await client.disconnect();
});

test("configuration save selects the wireless workflow from the board link and intent", async () => {
  const calls = [];
  const session = {
    state: { link: "usb" },
    async saveWireless(intent) { calls.push(["wireless", intent]); return { ssid: intent.ssid }; },
    async saveSettings(...args) { calls.push(["settings", ...args]); },
  };
  const operations = new Operations(session);
  const settings = { system_clock_mhz: 0, sdcard_profile: 0, radios: 3 };
  const wireless = { ssid: "ESPForge" };

  assert.deepEqual(await operations.saveConfiguration({ settings, wireless }), { ssid: "ESPForge" });
  assert.deepEqual(calls, [["wireless", { ...wireless, wifi_enabled: true, ble_enabled: true, board: settings }]]);

  calls.length = 0;
  session.state.link = "ble";
  assert.equal(await operations.saveConfiguration({ settings, wireless }), null);
  assert.deepEqual(calls, [["settings", settings]], "Bluetooth never stages credentials");

  calls.length = 0;
  session.state.link = "usb";
  assert.equal(await operations.saveConfiguration({ settings, wireless: null }), null);
  assert.deepEqual(calls, [["settings", settings]]);
});

test("scan lifecycle reads generation-indexed entries, keeps raw SSIDs and serializes the whole workflow", async () => {
  const setup = await connected();
  radio(setup, { scanEntries: [Uint8Array.from([0, 255, 65]), new TextEncoder().encode("normal")] });
  const pending = setup.client.scanWireless();
  await assert.rejects(setup.client.reboot(true), says(/unavailable/));
  const entries = await pending;
  assert.equal(entries[0].ssid_hex, "00ff41");
  assert.equal(entries[0].ssid, "\\x00\\xFFA");
  assert.equal(entries[0].rssi, -40);
  assert.deepEqual(setup.sent.map(bytes => bytes[3]), [11, 12, 12]);
  assert.deepEqual(setup.sent[1].slice(5, 8), [0, 1, 0]);
  assert.deepEqual(setup.sent[2].slice(5, 8), [1, 1, 0]);
  assert.equal(setup.client.state.pending_wireless, null);
  await setup.client.disconnect();
});

test("tested pair saves without restaging, key staging retains test, "
  + "save confirms exact switches and commit mask", async () => {
  const setup = await connected();
  const raw = Uint8Array.from([65, 0, 255]);
  radio(setup);
  const tested = await setup.client.testWireless({ ssid: "display only", ssid_hex: "4100FF", password: "password" });
  assert.ok(tested.remaining_seconds > 0 && tested.remaining_seconds <= 600);
  assert.deepEqual(setup.sent.map(bytes => bytes[3]), [6, 7, 9]);
  assert.deepEqual(setup.sent[0].slice(5, 9), [3, ...raw]);
  const saved = await setup.client.saveWireless({ ssid: tested.ssid, ssid_hex: tested.ssid_hex,
    use_tested_wifi: true, wifi_enabled: true, ble_enabled: true,
    ble_key: "ab".repeat(32), board: { ...BOARD, radios: 3 } });
  assert.deepEqual(setup.sent.map(bytes => bytes[3]), [6, 7, 9, 8, 5]);
  assert.deepEqual(setup.sent.at(-1).slice(1, 9), [1, 5, 5, 2, 160, 0, 0, 3]);
  assert.equal(saved.ssid_hex, "4100ff");
  assert.equal(saved.ssid, "A\\x00\\xFF");
  assert.equal(setup.client.state.reboot_pending, true);
  assert.equal(setup.client.state.outcome_uncertain, false);
  assert.equal(setup.pendingStore.getItem("espforge.direct.pending-operation"), null);
  await setup.client.disconnect();
});

test("password omission is safe only for the saved raw SSID; "
  + "explicit open/forget and cancel are supported", async () => {
  const setup = await connected();
  radio(setup);
  await assert.rejects(setup.client.testWireless({ ssid: "different" }), says(/explicit password/));
  assert.equal(setup.sent.length, 0);
  await setup.client.testWireless({ ssid: "home" });
  assert.deepEqual(setup.sent.map(bytes => bytes[3]), [6, 9]);
  await setup.client.cancelWireless();
  assert.equal(setup.sent.at(-1)[3], 10);
  assert.equal(setup.client.state.wireless.staged_mask, 0);
  await setup.client.testWireless({ ssid: "open", password: "" });
  assert.deepEqual(setup.sent.at(-2).slice(3, 7), [7, 0, 0, 0]);
  await setup.client.cancelWireless();
  await setup.client.saveWireless({ ssid: "", password: "", wifi_enabled: false, ble_enabled: false, board: BOARD });
  assert.deepEqual(setup.sent.slice(-2).map(bytes => bytes[3]), [6, 5], "empty SSID implicitly clears password");
  await setup.client.disconnect();
});

test("failed tests leave discardable staging but do not claim a tested pair", async () => {
  const setup = await connected(); radio(setup, { testFailure: true });
  await assert.rejects(setup.client.testWireless({ ssid: "home", password: "password" }), says(/Password rejected/));
  assert.equal(setup.client.state.outcome_uncertain, false);
  assert.equal(setup.client.state.pending_wireless, null);
  await setup.client.cancelWireless();
  await setup.client.disconnect();
});

test("malformed save settings and credentials reject before the first SET", async () => {
  const setup = await connected(); radio(setup);
  const base = { ssid: "home", wifi_enabled: true, ble_enabled: false, board: { ...BOARD, radios: 1 } };
  for (const change of [{ board: { ...base.board, system_clock_mhz: undefined } },
    { board: { ...base.board, sdcard_profile: 1 } }, { board: { ...base.board, system_clock_mhz: 200 } },
    { board: { ...base.board, radios: 5 } }, { wifi_enabled: false }, { use_tested_wifi: 1 },
    { ble_key: "0".repeat(63) }, { password: "short" }, { password: "é".repeat(8) }, { ssid_hex: "not hex" }]) {
    await assert.rejects(setup.client.saveWireless({ ...base, ...change }));
    assert.equal(setup.sent.length, 0);
  }
  await setup.client.disconnect();
});
