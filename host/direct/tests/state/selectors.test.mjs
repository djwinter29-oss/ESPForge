// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { canRun, deriveOperationEligibility } from "../../web/js/state/selectors.mjs";
import { describe } from "../../web/js/ui/messages.mjs";

const readyState = (changes = {}) => ({
  link: "usb",
  connected: true,
  busy: false,
  outcome_uncertain: false,
  reboot_pending: false,
  hardware: { capabilities: 2 | 4 | 16 | 128 },
  freshness: { 10: "fresh" },
  memory: { sample_valid: true },
  pending_request: null,
  pending_wireless: null,
  reconnecting: false,
  ...changes,
});

test("operation eligibility is one rule table for storage, settings and wireless gates", () => {
  assert.deepEqual(deriveOperationEligibility(readyState()), { blocked: false, storageReady: true,
    ledReady: false,
    settingsReady: true, wirelessReady: true, mscReady: false, connectionLocked: true,
    benchmarkSupported: false, benchmarkReady: false, benchmarkCancelReady: false });

  const flags = ["blocked", "storageReady", "settingsReady", "wirelessReady"];
  const cases = [
    ["disconnected", readyState({ connected: false }), [1, 1, 0, 0]],
    ["busy", readyState({ busy: true }), [1, 1, 0, 0]],
    ["uncertain", readyState({ outcome_uncertain: true }), [1, 1, 0, 0]],
    ["reboot pending", readyState({ reboot_pending: true }), [1, 1, 0, 0]],
    ["wireless busy", readyState({ wireless_busy: true }), [1, 1, 0, 0]],
    ["command pending", readyState({ pending_request: { opcode: 2 } }), [1, 1, 0, 0]],
    ["lifecycle pending", readyState({ pending_wireless: { operation: 9 } }), [1, 1, 0, 0]],
    ["storage stale", readyState({ freshness: { 10: "stale" } }), [0, 0, 0, 0]],
    ["storage cleared", readyState({ memory: null }), [0, 0, 0, 0]],
    ["Bluetooth", readyState({ link: "ble" }), [0, 1, 1, 0]],
    ["no radio", readyState({ hardware: { capabilities: 2 | 4 | 16 } }), [0, 1, 1, 0]],
  ];
  for (const [name, state, expected] of cases) {
    const eligibility = deriveOperationEligibility(state);
    assert.deepEqual(flags.map(flag => Number(eligibility[flag])), expected, name);
  }
  assert.equal(deriveOperationEligibility(readyState({ connected: false })).connectionLocked, false);
  assert.equal(deriveOperationEligibility(readyState({ connected: false, pending_request: {} })).connectionLocked,
    true);
});

test("benchmark starts need fresh firmware storage; cancellation works with a busy SD sample", () => {
  const state = readyState({ hardware: { capabilities: 0xb6 },
    freshness: { 10: "fresh", 11: "fresh" }, memory: { sample_valid: true, initialized: true },
    self_test: { active: false } });
  assert.equal(canRun(state, "benchmark").allowed, true);
  assert.equal(canRun({ ...state, link: "ble" }, "benchmark").allowed, false);
  assert.equal(canRun({ ...state, freshness: { 10: "fresh", 11: "stale" } }, "benchmark").allowed, false);
  const active = { ...state, self_test: { active: true }, memory: { sample_valid: false } };
  assert.equal(canRun(active, "benchmark").allowed, false);
  assert.equal(canRun(active, "settings").allowed, false);
  assert.equal(canRun(active, "benchmark-cancel").allowed, true);
  assert.equal(canRun({ ...active, outcome_uncertain: true }, "benchmark-cancel").allowed, false);
});

test("canRun is the one gate and names the first failing precondition per operation", () => {
  const ready = readyState();
  for (const operation of ["reboot", "settings", "wireless"]) {
    assert.deepEqual(canRun(ready, operation), { allowed: true, reason: null }, operation);
  }
  for (const operation of ["reboot", "settings"]) {
    assert.deepEqual(canRun({ ...ready, link: "ble" }, operation), { allowed: true, reason: null },
      `${operation} over Bluetooth`);
  }
  const blocked = "Command unavailable or previous outcome uncertain";
  const wireless = "Wireless configuration requires USB and fresh storage status.";
  const cases = [
    ["reboot", { freshness: { 10: "stale" } }, "Fresh storage status required"],
    ["reboot", { hardware: { capabilities: 16 } }, "Unavailable capability"],
    ["reboot", { busy: true }, blocked],
    ["settings", { memory: null }, "Fresh storage status required before saving."],
    ["settings", { hardware: { capabilities: 16 } }, "Unavailable capability"],
    ["settings", { pending_request: { opcode: 2 } }, blocked],
    ["wireless", { wireless_busy: true }, wireless],
    ["wireless", { link: "ble" }, wireless],
    ["wireless", { hardware: { capabilities: 2 | 4 | 16 } }, wireless],
  ];
  for (const [operation, changes, reason] of cases) {
    const result = canRun({ ...ready, ...changes }, operation);
    assert.deepEqual({ ...result, reason: describe(result.reason) }, { allowed: false, reason },
      `${operation} ${JSON.stringify(changes)}`);
  }
});

test("render gates reuse one eligibility snapshot while action gates still recompute", () => {
  const state = readyState();
  let reads = 0;
  const freshness = state.freshness;
  Object.defineProperty(state, "freshness", { get() { reads++; return freshness; } });
  const eligibility = deriveOperationEligibility(state);
  reads = 0;
  for (const operation of ["reboot", "settings", "wireless"]) {
    assert.equal(canRun(state, operation, eligibility).allowed, true);
  }
  assert.equal(reads, 0, "render-time checks do not rederive eligibility");
  state.busy = true;
  assert.equal(canRun(state, "settings").allowed, false, "action-time checks never reuse a stale render cache");
  assert.ok(reads > 0);
});
