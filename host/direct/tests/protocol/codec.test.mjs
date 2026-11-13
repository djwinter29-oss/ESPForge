// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeIdentityReport, decodeConfigReport, decodeTelemetryReport, decodeStorageReport,
  decodeControlResult, buildControlRequest, decodeWireless, displaySsid, matchesEspForge, ssidBytes,
} from "../../web/js/protocol/codec.mjs";
import { identity, config, telemetry, storage, result } from "../support/fixtures.mjs";
import { status } from "../support/wireless.mjs";

/** @brief Report 12 vectors with the ESPForge SSID; byte 4 never carries the TCP CLI bit. */
const ssid = Buffer.from("ESPForge").toString("hex");
const vectors = {
  connected_with_key: `01020002032a2a2a2a08${ssid}${"00".repeat(30)}`,
  tested_candidate: `01050002b32a2a2a2a08${ssid}${"00".repeat(28)}0100`,
  test_failed_saved_link_serving: `01060600b32a2a2a2a08${ssid}${"00".repeat(28)}0100`,
  radio_init_failed_while_connected: `01020100012a2a2a2a08${ssid}${"00".repeat(30)}`,
};

test("identity requires ESPForge product 3, the 0x96 capability set, ESP32-S3 and valid RAM", () => {
  const report = identity();
  const decoded = decodeIdentityReport(report);
  assert.equal(decoded.product_name, "ESPForge");
  assert.equal(decoded.serial_number, "0102030405060708");
  assert.equal(decoded.firmware_version, "1.2.3");
  assert.deepEqual([decoded.mcu, decoded.board_name, decoded.transport], ["ESP32-S3", "ESP32-S3-DevKitC-1", "sdmmc"]);
  assert.equal(decoded.capabilities, 0x96);
  for (const bytes of [report.slice(0, 25), Uint8Array.from([1, ...report]), new Uint8Array(42)]) {
    assert.throws(() => decodeIdentityReport(bytes));
  }
  for (const [offset, value] of [[0, 2], [1, 2], [1, 1], [17, 0], [17, 0x8f], [17, 0x9e], [17, 0xae],
    [17, 0x86], [14, 1]]) {
    const bad = report.slice(); bad[offset] = value;
    assert.throws(() => decodeIdentityReport(bad), `${offset}: ${value}`);
  }
  assert.equal(decodeIdentityReport(identity(16 | 128)).capabilities, 0x90, "capabilities may be a subset");
  assert.throws(() => decodeIdentityReport(identity(0x8e)), "legacy SPI firmware requires matching hosts");
  const reserved = report.slice(); reserved[16] = 255;
  assert.equal(decodeIdentityReport(reserved).product_name, "ESPForge", "identity reserved byte is ignored");
  const unknown = report.slice(); unknown[14] = 99; unknown[15] = 99;
  assert.equal(decodeIdentityReport(unknown).mcu, null);
  assert.equal(decodeIdentityReport(unknown).board_model, 99);
  for (const [total, used] of [[0, 0], [100, 101]]) {
    const bad = report.slice(); const view = new DataView(bad.buffer);
    view.setUint32(18, total, true); view.setUint32(22, used, true);
    assert.throws(() => decodeIdentityReport(bad));
  }
});

test("WebHID matching needs the ESPForge VID:PID and the vendor collection", () => {
  const device = { vendorId: 0xcafe, productId: 0x4021, collections: [{ usagePage: 0xff00, usage: 1 }] };
  assert.ok(matchesEspForge(device));
  for (const change of [{ productId: 0x4011 }, { vendorId: 0x2e8a }, { collections: [{ usagePage: 0xff00, usage: 2 }] }]) {
    assert.ok(!matchesEspForge({ ...device, ...change }), JSON.stringify(change));
  }
});

test("configuration validates ESPForge clocks, SD profile 0, SDMMC GPIOs, monitor UART and optional card detect", () => {
  const id = decodeIdentityReport(identity());
  const decoded = decodeConfigReport(config(), id);
  assert.deepEqual([decoded.system_clock_mhz, decoded.sdcard_profile, decoded.radios], [240, 0, 0]);
  assert.deepEqual(decoded.storage_gpios, [12, 11, 13, 14, 15, 10]);
  assert.deepEqual([decoded.monitor_uart_index, decoded.monitor_uart_tx_gpio, decoded.monitor_uart_rx_gpio], [0, 43, 44]);
  assert.equal(Object.hasOwn(decoded, "led_gpio"), false);
  assert.equal(decoded.card_detect_gpio, 255);
  for (const clock of [0, 80, 160]) {
    const report = config(); report[1] = clock;
    assert.equal(decodeConfigReport(report, id).system_clock_mhz, clock);
  }
  for (const [offset, value] of [[1, 200], [1, 125], [3, 1], [4, 2], [5, 255], [6, 255], [7, 255], [7, 49],
    [10, 255], [11, 255], [12, 255], [13, 0], [13, 4 | 1], [13, 4 | 2], [13, 4 | 32], [15, 2], [16, 3]]) {
    const bad = config(); bad[offset] = value;
    assert.throws(() => decodeConfigReport(bad, id), `${offset}: ${value}`);
  }
  assert.equal(decodeConfigReport(config(3), id).radios, 3);
  assert.throws(() => decodeConfigReport(config(1), decodeIdentityReport(identity(2 | 4 | 16))),
    "radios need the wireless capability");
  const unknownReset = config(); unknownReset[14] = 255;
  assert.equal(decodeConfigReport(unknownReset, id).reset_cause, 255);
});

test("telemetry preserves 64-bit uptime, the core-0 load sentinel and temperature, with no LED or core-1 load", () => {
  const report = telemetry();
  const view = new DataView(report.buffer);
  assert.equal(decodeTelemetryReport(report).system_clock_hz, 240000000);
  assert.equal(decodeTelemetryReport(report).cpu_usage_core0_basis_points, 1234);
  view.setBigUint64(4, 2n ** 63n + 123n, true);
  view.setUint16(12, 65535, true);
  const decoded = decodeTelemetryReport(report);
  assert.equal(decoded.uptime_ms, 2n ** 63n + 123n);
  assert.equal(decoded.cpu_usage_core0_basis_points, null);
  assert.equal(decoded.cpu_usage_core1_basis_points, null);
  assert.equal(decoded.temperature_centidegrees, -1234);
  for (const field of ["led_on", "led_mode", "cdc_open"]) {
    assert.equal(Object.hasOwn(decoded, field), false, field);
  }
  for (const [offset, value] of [[1, 1], [1, 2], [21, 128], [21, 2 | 5], [21, 8 | 5]]) {
    const bad = report.slice(); bad[offset] = value;
    assert.throws(() => decodeTelemetryReport(bad), `${offset}: ${value}`);
  }
  for (const [offset, load] of [[12, 10001], [12, 65534], [14, 0], [14, 5000]]) {
    const bad = report.slice(); new DataView(bad.buffer).setUint16(offset, load, true);
    assert.throws(() => decodeTelemetryReport(bad), `${offset}: ${load}`);
  }
  assert.throws(() => decodeTelemetryReport(Uint8Array.from([...telemetry(), 0])));
  const absent = telemetry(); absent[21] = 1;
  new DataView(absent.buffer).setInt16(2, 0, true);
  assert.equal(decodeTelemetryReport(absent).temperature_centidegrees, null);
});

test("storage validates native SDMMC samples, timing, capacity and CID with isolated MSC ownership", () => {
  const decoded = decodeStorageReport(storage());
  assert.equal(decoded.memory.mode, "sdmmc");
  assert.equal(decoded.memory.capacity_bytes, 512 * 100000);
  assert.equal(decoded.memory.manufacturer, null);
  assert.equal(decoded.filesystem_format, "fat32");
  assert.equal(Object.hasOwn(decoded, "msc"), false);
  const cid = storage(); cid[2] |= 16;
  cid.set([0x03, 0x53, 0x44, 0x53, 0x44, 0x31, 0x36, 0x47, 0x80, 0x12, 0x34, 0x56, 0x78, 0x01, 0x91], 14);
  assert.equal(decodeStorageReport(cid).memory.manufacturer.product_name, "SD16G");
  assert.equal(decodeStorageReport(cid).memory.manufacturer.serial_number, 0x12345678);
  assert.equal(decodeStorageReport(cid).memory.manufacturer.manufacture_year, 2025);
  for (const [offset, value] of [[2, 128], [2, 63], [2, 64], [2, 71], [4, 1], [4, 2], [3, 2], [9, 0], [9, 3],
    [31, 1], [32, 1], [33, 2], [30, 5], [14, 1]]) {
    const bad = storage(); bad[offset] = value;
    assert.throws(() => decodeStorageReport(bad), `${offset}: ${value}`);
  }
  const unavailable = new Uint8Array(34);
  unavailable[0] = 1; unavailable[2] = 1;
  assert.equal(decodeStorageReport(unavailable).memory.sample_valid, false);
  unavailable[14] = 1;
  assert.throws(() => decodeStorageReport(unavailable));
  const absent = new Uint8Array(34); absent[0] = 1; absent[2] = 67;
  assert.equal(decodeStorageReport(absent).memory.present, false);
  absent[2] |= 16;
  assert.throws(() => decodeStorageReport(absent));
  const mountFailed = new Uint8Array(34); mountFailed[0] = 1; mountFailed[2] = 0x41;
  const failed = decodeStorageReport(mountFailed).memory;
  assert.equal(failed.sample_valid, true);
  assert.equal(failed.presence_known, false);
  assert.equal(failed.initialized, false);
  assert.equal(failed.mode, null);
  assert.throws(() => decodeStorageReport(storage().slice(0, 33)));
});

test("control request builders encode exact 68-byte envelopes and reject malformed operations", () => {
  const padded = prefix => [...prefix, ...Array(68 - prefix.length).fill(0)];
  assert.deepEqual([...buildControlRequest(1, 2, { flags: 1 })], padded([1, 1, 2, 1]));
  assert.deepEqual([...buildControlRequest(2, 5, { args: [240, 0, 0, 1] })], padded([1, 2, 5, 0, 240, 0, 0, 1]));
  assert.deepEqual([...buildControlRequest(255, 5, { flags: 2, args: [80, 0, 0, 3] })],
    padded([1, 255, 5, 2, 80, 0, 0, 3]));
  for (const [opcode, options] of [[2, {}], [2, { flags: 3 }], [2, { flags: 1, args: [1] }],
    [5, { args: [200, 0, 0, 0] }], [5, { args: [240, 0, 1, 0] }], [5, { args: [240, 0, 0, 4] }],
    [5, { args: [240, 0, 0, 0, 1] }], [5, { flags: 1, args: [240, 0, 0, 0] }], [5, { flags: 4, args: [240, 0, 0, 0] }],
    [6, { args: [33] }], [0, {}], [1, { args: [1] }], [3, { args: [0] }], [4, { args: [1, 0, 1, 0, 0] }],
    [13, { args: Array(16).fill(1) }], [14, {}], [10, { flags: 1 }], [11, { args: [1] }]]) {
    assert.throws(() => buildControlRequest(1, opcode, options), `opcode ${opcode}`);
  }
  assert.throws(() => buildControlRequest(0, 2, { flags: 1 }));
});

test("control results enforce every opcode/status/error combination and zero result data", () => {
  const unsupported = [[4, 4]];
  const allowed = {
    1: unsupported, 4: unsupported, 13: unsupported,
    3: [[1, 0], [2, 0], [3, 1], [3, 2], [3, 3], [4, 4], [5, 5], [6, 6]],
    2: [[1, 0], [2, 0], [3, 1], [3, 2], [5, 5], [6, 6]],
    5: [[1, 0], [2, 0], [3, 1], [3, 3], [4, 4], [5, 5], [6, 6]],
    6: [[2, 0], [3, 1], [3, 3], [4, 4], [5, 5], [6, 6]],
    0: [[4, 7]], 14: [[4, 7]], 255: [[4, 7]],
  };
  for (const [op, combinations] of Object.entries(allowed)) {
    for (let status = 0; status <= 7; status++) for (let error = 0; error <= 8; error++) {
      const bytes = result(1, Number(op), status, error);
      const valid = combinations.some(pair => pair[0] === status && pair[1] === error);
      if (valid) assert.doesNotThrow(() => decodeControlResult(bytes), `${op}/${status}/${error}`);
      else assert.throws(() => decodeControlResult(bytes), `${op}/${status}/${error}`);
    }
  }
  assert.equal(decodeControlResult(result(0, 0, 0)).status, 0);
  for (const report of [result(0, 2), Uint8Array.from([...result(1, 2), 0])]) {
    assert.throws(() => decodeControlResult(report));
  }
  const badData = result(1, 2); badData[5] = 1;
  assert.throws(() => decodeControlResult(badData));
  const saved = result(1, 5); saved.set([160, 0, 0, 0], 5);
  assert.deepEqual(decodeControlResult(saved).settings, { system_clock_mhz: 160, sdcard_profile: 0, radios: 0 });
  saved[8] = 3;
  assert.equal(decodeControlResult(saved).settings.radios, 3);
  for (const [offset, value] of [[8, 4], [8, 6], [7, 1], [5, 200]]) {
    const bad = saved.slice(); bad[offset] = value;
    assert.throws(() => decodeControlResult(bad), `${offset}: ${value}`);
  }
});

test("all decoders reject padded, short and unsupported-layout payloads", () => {
  const id = decodeIdentityReport(identity());
  for (const [decode, bytes] of [[decodeIdentityReport, identity()],
    [data => decodeConfigReport(data, id), config()], [decodeTelemetryReport, telemetry()],
    [decodeStorageReport, storage()], [decodeControlResult, result(1, 2)]]) {
    assert.throws(() => decode(bytes.slice(0, -1)));
    assert.throws(() => decode(Uint8Array.from([...bytes, 0])));
    const wrongVersion = bytes.slice(); wrongVersion[0] = 2;
    assert.throws(() => decode(wrongVersion));
    const buffer = new Uint8Array(bytes.length + 2); buffer.set(bytes, 1);
    assert.doesNotThrow(() => decode(new DataView(buffer.buffer, 1, bytes.length)));
  }
});

test("Report12 uses exact48byte vectors, raw SSIDs and no fabricated removed diagnostics", () => {
  const wireless = decodeWireless(Buffer.from(vectors.connected_with_key, "hex"), { radios: 3 });
  assert.equal(wireless.ssid, "ESPForge");
  assert.equal(wireless.ssid_hex, "455350466f726765");
  assert.deepEqual([wireless.wifi_enabled, wireless.ble_enabled, wireless.ble_key_configured], [true, true, true]);
  for (const field of ["rssi", "reconnect_count", "wifi_auth_state", "restart_required", "password_configured",
    "transaction_id", "tcp_cli_started", "tcp_cli_auth_required", "error"]) {
    assert.equal(Object.hasOwn(wireless, field), false, field);
  }
  const tcp = Buffer.from(vectors.connected_with_key, "hex"); tcp[4] |= 4;
  assert.throws(() => decodeWireless(tcp), "ESPForge never reports a TCP CLI");
  const candidate = decodeWireless(Buffer.from(vectors.tested_candidate, "hex"));
  assert.equal(candidate.pair_tested, true);
  assert.equal(candidate.test_generation, 1);
  const lost = decodeWireless(Buffer.from(vectors.test_failed_saved_link_serving, "hex"));
  assert.deepEqual([lost.wifi_state, lost.ipv4, lost.pair_tested], ["test_failed", "42.42.42.42", true]);
  const init = decodeWireless(Buffer.from(vectors.radio_init_failed_while_connected, "hex"));
  assert.deepEqual([init.wifi_state, init.detail], ["connected", 1]);
  assert.equal(candidate.wifi_state, "test_joined");
  for (const bad of [new Uint8Array(53), status().slice(1), new Uint8Array(49)]) {
    assert.throws(() => decodeWireless(bad));
  }
  for (const [offset, value] of [[0, 2], [1, 7], [3, 3], [9, 33], [10, 1], [42, 4], [45, 19], [47, 1]]) {
    const bad = status(); bad[offset] = value;
    assert.throws(() => decodeWireless(bad), `${offset}/${value}`);
  }
  const reserved = status(); reserved[2] = 255; reserved[4] = 8; reserved[47] = 128;
  assert.equal(decodeWireless(reserved).detail, 0, "reserved detail/flag bits are ignored");
});

test("opaque SSIDs escape invalid UTF8 and controls but round-trip raw bytes rather than the label", () => {
  const raw = Uint8Array.from([0x61, 0, 255, 0xc3, 0xa9, 0x3c, 10]);
  const wireless = decodeWireless(status({ ssid: raw }));
  assert.equal(wireless.ssid, "a\\x00\\xFFé<\\x0A");
  assert.equal(wireless.ssid_hex, "6100ffc3a93c0a");
  assert.deepEqual(ssidBytes({ ssid: wireless.ssid, ssid_hex: wireless.ssid_hex.toUpperCase() }), raw);
  assert.equal(displaySsid(Uint8Array.from([0xe2, 0x80, 0xae])), "\\xE2\\x80\\xAE");
  assert.throws(() => ssidBytes({ ssid_hex: "bad" }));
  assert.throws(() => ssidBytes({ ssid_hex: "aa".repeat(33) }));
  assert.throws(() => ssidBytes({ ssid: "é".repeat(17) }));
});

test("staging, scan index/generation and proof requests use64argument bytes with zero padding", () => {
  for (const [op, args] of [[6, [3, 0, 255, 1]], [7, [8, ...new TextEncoder().encode("password")]],
    [8, [32, ...Array(32).fill(0xab)]], [9, []], [10, []], [11, []], [12, [17, 0x34, 0x12]]]) {
    const request = buildControlRequest(255, op, { args });
    assert.equal(request.length, 68);
    assert.deepEqual([...request.slice(0, 4 + args.length)], [1, 255, op, 0, ...args]);
    assert.ok(request.subarray(4 + args.length).every(byte => !byte));
  }
  for (const [op, args] of [[6, [33]], [7, [7, ...Array(7).fill(65)]], [7, [8, ...Array(8).fill(0)]],
    [8, [31]], [9, [1]], [12, [18, 1]], [12, [0, 0, 0]], [13, Array(16).fill(1)]]) {
    assert.throws(() => buildControlRequest(1, op, { args }));
  }
});

test("strict result validation enforces details, scan padding, commit masks and opcode status rules", () => {
  for (const [op, state, error, detail] of [[6, 3, 3, 16], [7, 3, 3, 17], [8, 3, 3, 18],
    [9, 3, 3, 19], [5, 3, 3, 20], [9, 3, 3, 21], [12, 3, 3, 22], [12, 3, 3, 23],
    [8, 5, 5, 25], [11, 5, 5, 26], [5, 3, 3, 27], [5, 5, 5, 28]]) {
    const bytes = result(1, op, state, error); bytes[5] = detail;
    assert.equal(decodeControlResult(bytes, { ble: detail === 28 }).detail, detail);
    if (detail === 28) assert.throws(() => decodeControlResult(bytes));
    bytes[6] = 1; assert.throws(() => decodeControlResult(bytes));
    bytes[6] = 0; bytes[2] = 1; assert.throws(() => decodeControlResult(bytes));
  }
  for (const op of [6, 7, 8, 10, 12]) assert.throws(() => decodeControlResult(result(1, op, 1)));
  const scan = result(1, 12); scan.set([1, 0, 0, 1, 255], 5); scan[41] = 216; scan[42] = 7;
  assert.doesNotThrow(() => decodeControlResult(scan));
  for (const [offset, value] of [[5, 0], [7, 18], [8, 33], [10, 1], [42, 8], [43, 1]]) {
    const bad = scan.slice(); bad[offset] = value; assert.throws(() => decodeControlResult(bad));
  }
  const saved = result(1, 5); saved.set([240, 0, 0, 3, 7], 5);
  assert.equal(decodeControlResult(saved).commit_mask, 7);
  saved[9] = 8; assert.throws(() => decodeControlResult(saved));
});
