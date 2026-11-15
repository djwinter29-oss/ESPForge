// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { formTransition, IDLE_FORM } from "../../../../web/js/ui/sections/wireless-form/wireless-form-state.mjs";

test("form transitions serialize one phase and require reconnect recovery before retry", () => {
  const step = (form, ...events) => events.reduce((value, event) =>
    formTransition(value, typeof event === "string" ? { type: event } : event), form);
  const idle = step(IDLE_FORM, "reset");
  assert.equal(idle.phase, "idle");
  assert.equal(step(idle, "scan", "test").phase, "scanning", "a running scan rejects a test");
  assert.equal(step(idle, "scan", "done").phase, "idle");
  assert.equal(step(idle, "test", "cancel").phase, "testing", "cancel waits for the test to finish");
  const failed = step(idle, { type: "cancel" }, { type: "cancelFailed", error: "x", needsReconnect: true });
  assert.deepEqual(failed, { ...IDLE_FORM, phase: "cancelFailed", cancelError: "x", cancelNeedsReconnect: true });
  assert.equal(step(failed, "cancel"), failed, "retry is refused until the board reconnects");
  assert.equal(step(failed, "recovered", "cancel", "cleared").phase, "idle");
  assert.equal(step(idle, "test", "reset").phase, "idle", "reset drops any in-flight phase");
});

test("Wi-Fi draft state keeps tested credentials and selected SSID facts in one transition model", () => {
  const pair = { ssid: "Lab", ssid_hex: "4c6162", use_tested_wifi: true, tested_at: 20, remaining_seconds: 600 };
  const attempted = formTransition(IDLE_FORM, { type: "testStarted" });
  assert.equal(attempted.wifiTestAttempted, true);
  assert.equal(attempted.wifiStage, null);
  const staged = formTransition(attempted, { type: "testSucceeded", pair });
  const idle = formTransition(staged, { type: "done" });
  assert.equal(idle.phase, "idle");
  assert.deepEqual(idle.wifiStage, pair);
  assert.equal(idle.wifiTestAttempted, true);
  assert.equal(formTransition(idle, { type: "selectNetwork", ssidHex: "4c6162" }).wifiEdited, true);
  assert.equal(formTransition(idle, { type: "editSsid" }).selectedSsidHex, undefined);
  const cleared = formTransition(idle, { type: "clearWifiStage" });
  assert.equal(cleared.wifiStage, null);
  assert.equal(cleared.wifiTestAttempted, false);
  assert.equal(cleared.wifiEdited, false);
});
