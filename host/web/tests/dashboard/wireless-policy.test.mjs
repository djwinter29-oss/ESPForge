// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import {
  editWirelessRadio, wirelessCredentialActions, wirelessDirty, wirelessSaveBlockReason,
  wirelessSaveIdentity, wirelessSaveRequest, wirelessSelectedRadios,
} from "../../src/js/dashboard/wireless-policy.mjs";

const state = overrides => ({
  status: { ssid: "saved", wifi_enabled: true, ble_enabled: true, ble_key_configured: true },
  draft: {},
  ssid: "",
  password: "",
  bleKey: "",
  configurationConflict: false,
  foreignStage: false,
  awaitingPair: false,
  wifiStage: null,
  wifiAttempt: null,
  selectedSsidHex: null,
  wifiEdited: false,
  keyDirty: false,
  keyNeedsRegeneration: false,
  keyRevision: 0,
  busy: false,
  wifiCanceling: false,
  wifiCancelError: null,
  cleanupRequired: false,
  remainingTestSeconds: 0,
  ...overrides,
});

test("radio edits are immutable and remove intent when restored to the saved value", () => {
  const baseline = {};
  const disabled = editWirelessRadio(baseline, { wifi_enabled: true }, "wifi", false);
  assert.deepEqual(baseline, {});
  assert.deepEqual(disabled, { wifi: false });
  assert.deepEqual(editWirelessRadio(disabled, { wifi_enabled: true }, "wifi", true), {});
});

test("credential policy emits erase actions only for explicitly disabled configured radios", () => {
  const edited = { wifi: false, ble: true };
  const next = state({ draft: edited });
  assert.deepEqual(wirelessCredentialActions(next), { wifi: "erase", ble: "preserve" });
  assert.equal(wirelessDirty(next), true);
  assert.deepEqual(wirelessSaveRequest(next), {
    wifi_enabled: false, ble_enabled: true, confirm_reboot: true, ssid: "", password: "",
  });
  assert.deepEqual(wirelessCredentialActions(state({ draft: { wifi: true } })), {
    wifi: "preserve", ble: "preserve",
  });
});

test("tested-pair freshness and conflicts block serialization before credentials are emitted", () => {
  const tested = { ssid: "candidate", ssid_hex: "63616e646964617465", use_tested_wifi: true,
    tested_at: 0, remaining_seconds: 10, test_generation: 3, test_id: "a".repeat(32) };
  const valid = state({ wifiStage: tested, draft: { wifi: true }, remainingTestSeconds: 1 });
  assert.equal(wirelessSaveBlockReason(valid), null);
  assert.deepEqual(wirelessSaveRequest(valid), {
    wifi_enabled: true, ble_enabled: true, confirm_reboot: true, ssid: "candidate",
    ssid_hex: "63616e646964617465", use_tested_wifi: true, test_generation: 3, test_id: "a".repeat(32),
  });
  assert.match(wirelessSaveBlockReason({ ...valid, remainingTestSeconds: 0 }), /expired/);
  assert.match(wirelessSaveBlockReason({ ...valid, configurationConflict: true }), /changed on the board/);
});

test("confirmation identity tracks credential revisions without containing credential bytes", () => {
  const baseline = state();
  const changed = state({ keyDirty: true, keyRevision: 1, bleKey: "secret-control-key" });
  assert.notEqual(wirelessSaveIdentity(changed), wirelessSaveIdentity(baseline));
  assert.equal(wirelessSaveIdentity(changed).includes("secret-control-key"), false);
  assert.equal(wirelessSelectedRadios(state({ draft: { wifi: false, ble: true } }), 3), 2);
});
