// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { buildControlRequest, decodeControlResult } from "../../web/js/protocol/codec.mjs";
import { OP, UNSUPPORTED_OPCODES } from "../../web/js/protocol/constants.mjs";
import { decodeSettings, encodeSettings, validSettings } from "../../web/js/protocol/opcodes.mjs";
import { result, says } from "../support/fixtures.mjs";

test("settings codec round-trips the four save-settings argument bytes", () => {
  const settings = { system_clock_mhz: 240, sdcard_profile: 0, radios: 3 };
  const args = encodeSettings(settings);
  assert.deepEqual(args, [240, 0, 0, 3]);
  assert.deepEqual(decodeSettings(args), settings);
  assert.deepEqual(decodeSettings(encodeSettings({ ...settings, radios: undefined })), { ...settings, radios: 0 });
});

test("ESPForge settings accept only its clocks, the one SD profile and switch bits 0 and 1", () => {
  for (const clock of [0, 80, 160, 240]) assert.ok(validSettings({ system_clock_mhz: clock, sdcard_profile: 0, radios: 0 }));
  for (const clock of [125, 200, 300]) assert.ok(!validSettings({ system_clock_mhz: clock, sdcard_profile: 0 }));
  assert.ok(!validSettings({ system_clock_mhz: 0, sdcard_profile: 1 }), "no High-Speed profile");
  assert.ok(!validSettings({ system_clock_mhz: 0, sdcard_profile: 0, radios: 4 }), "no TCP CLI switch");
  const request = (flags, args) => {
    try { buildControlRequest(1, OP.SAVE_SETTINGS, { flags, args }); return true; } catch { return false; }
  };
  assert.ok(request(0, [160, 0, 0, 3]));
  assert.ok(request(2, [0, 0, 0, 0]));
  assert.ok(!request(1, [0, 0, 0, 0]), "forced save is unsupported");
  assert.ok(!request(0, [0, 0, 1, 0]), "SD profile 1 is invalid");
  assert.ok(!request(0, [0, 0, 0, 4]), "switch bit 2 is invalid");
});

test("unsupported opcodes are never built and only an Unsupported result is accepted for them", () => {
  for (const opcode of UNSUPPORTED_OPCODES) {
    assert.throws(() => buildControlRequest(1, opcode), says(/Invalid HID control request/));
    assert.equal(decodeControlResult(result(5, opcode, 4, 4)).status, 4);
    for (const [status, error] of [[2, 0], [3, 3], [4, 7], [5, 5]]) {
      assert.throws(() => decodeControlResult(result(5, opcode, status, error)), says(/Invalid HID control result/));
    }
  }
});
