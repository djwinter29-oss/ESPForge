// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_REBOOT, CAPABILITY_SETTINGS, CAPABILITY_SDMMC, CAPABILITY_WIRELESS,
  commandEffects, commandSettled, createCommandState, observeCommandStatus, operationState,
} from "../../src/js/operation-state.mjs";

const ready = {
  connected: true, hardware: { capabilities: 0x96 }, msc: { enabled: false, transition_pending: false },
  storage_stale: false, memory: { initialized: true },
};

test("RGB controls require fresh known colour and remain independent of storage", () => {
  const state = { ...ready, hardware: { capabilities: 0xb7 }, telemetry_stale: false,
    runtime: { led_available: true, led_colour: 4 }, storage_stale: true,
    self_test: { active: true }, self_test_stale: false, msc: { enabled: true } };
  assert.equal(operationState(state).canSetLed, true);
  for (const changes of [{ telemetry_stale: true }, { telemetry_stale: undefined },
    { runtime: { led_available: false, led_colour: null } }, { runtime: { led_available: true } },
    { hardware: { capabilities: 0xb6 } }, { command_outcome_uncertain: true }])
    assert.equal(operationState({ ...state, ...changes }).canSetLed, false);
  assert.equal(operationState(state, { saving: true }).canSetLed, false);
  assert.equal(operationState(state, { wirelessInFlight: true }).canSetLed, false);
});

test("MSC controls require advertised support, a mounted card, and settled ownership", () => {
  const supported = { ...ready, board_configuration: { board_flags: 0x45 } };
  assert.equal(operationState(ready).canEnableMsc, false);
  assert.equal(operationState(supported).canEnableMsc, true);
  assert.equal(operationState(supported).canReturnMsc, false);
  const owned = { ...supported, memory: { initialized: false, sample_valid: false },
    msc: { enabled: true, transition_pending: false } };
  assert.equal(operationState(owned).canEnableMsc, false);
  assert.equal(operationState(owned).canReturnMsc, true);
  assert.equal(operationState(owned).canReboot, false);
  for (const changes of [{ storage_stale: true }, { msc: { enabled: true, transition_pending: true } }])
    assert.equal(operationState({ ...owned, ...changes }).canReturnMsc, false);
});

test("benchmark gates require capability and freshness, but cancel allows busy storage", () => {
  const state = { ...ready, hardware: { capabilities: 0xb6 },
    self_test: { active: false }, self_test_stale: false, settings_supported: true,
    settings: { system_clock_mhz: 160, sdcard_profile: 0, radios: 0 } };
  assert.equal(operationState(state).canStartBenchmark, true);
  assert.equal(operationState(state, { settingsDirty: true }).canSaveSettings, true);
  assert.equal(operationState({ ...state, self_test_stale: true },
    { settingsDirty: true }).canSaveSettings, false);
  assert.equal(operationState({ ...state, self_test_stale: true }).canStartBenchmark, false);
  assert.equal(operationState(ready).canStartBenchmark, false);
  const active = { ...state, self_test: { active: true }, memory: { sample_valid: false } };
  assert.equal(operationState(active).canStartBenchmark, false);
  assert.equal(operationState(active).canReboot, false);
  assert.equal(operationState({ ...state, self_test: { active: true } },
    { settingsDirty: true }).canSaveSettings, false);
  assert.equal(operationState(active).canCancelBenchmark, true);
  assert.equal(operationState(active, { uncertain: true }).canCancelBenchmark, false);
});

test("capability bits match the ESPForge profile", () => {
  assert.deepEqual([CAPABILITY_REBOOT, CAPABILITY_SETTINGS, CAPABILITY_SDMMC, CAPABILITY_WIRELESS], [2, 4, 16, 128]);
  assert.equal(CAPABILITY_REBOOT | CAPABILITY_SETTINGS | CAPABILITY_SDMMC | CAPABILITY_WIRELESS, 0x96);
});

test("one Save projection supplies eligibility and the same reason for all draft and board gates", () => {
  const facts = { ...ready, settings_supported: true,
    settings: { system_clock_mhz: 160, sdcard_profile: 0, radios: 1 }, wireless: { stale: false } };
  const draft = { settingsDirty: true };
  assert.equal(operationState(facts, draft).canSaveSettings, true);
  assert.equal(operationState(facts, draft).saveBlockReason, null);
  for (const [changes, activity, reason] of [
    [{ connected: false }, {}, /Waiting for an ESPForge connection/],
    [{ settings_supported: false }, {}, /Boot settings unavailable/],
    [{ settings_supported: false, settings_message: "Settings report invalid." }, {}, /Settings report invalid/],
    [{ hardware: { capabilities: 0x96 & ~CAPABILITY_SETTINGS } }, {}, /does not support/],
    [{}, { saving: true }, /pending operation/],
    [{}, { uncertain: true }, /recovery/],
    [{}, { rebootPending: true }, /pending operation/],
    [{ storage_stale: true }, {}, /fresh storage status/],
    [{ msc: null }, {}, /fresh storage status/],
    [{ msc: { enabled: true } }, {}, /Safely eject/],
    [{ msc: { transition_pending: true } }, {}, /storage to become idle/],
    [{ wireless: null }, { radiosDirty: true }, /fresh wireless/],
    [{}, { wirelessBlockReason: "Retest credentials." }, /Retest credentials/],
    [{ wireless: { stale: true } }, { wirelessDirty: true }, /fresh wireless and storage/],
    [{}, { settingsDirty: false }, /No unsaved/],
  ]) {
    const state = operationState({ ...facts, ...changes }, { ...draft, ...activity });
    assert.equal(state.canSaveSettings, false, JSON.stringify(changes));
    assert.match(state.saveBlockReason, reason);
  }
  assert.equal(operationState({ ...facts, wireless: null }, draft).canSaveSettings, true);
});

test("radio writes require fresh wireless facts while unrelated settings preserve saved radios", () => {
  const facts = { ...ready, settings_supported: true,
    settings: { system_clock_mhz: 160, sdcard_profile: 0, radios: 1 }, wireless: { stale: false } };
  assert.equal(operationState(facts, { radiosDirty: true, settingsDirty: true }).canSaveSettings, true);
  assert.equal(operationState(facts).canProvisionWireless, true);
  for (const changes of [{ wireless: null }, { wireless: { stale: true } }, { wireless_error: "read failed" }]) {
    const state = operationState({ ...facts, ...changes }, { radiosDirty: true, settingsDirty: true });
    assert.equal(state.wirelessStatusReady, false);
    assert.equal(state.canSaveSettings, false);
    assert.equal(state.canProvisionWireless, false);
    assert.match(state.wirelessBlockReason, /Waiting for fresh wireless configuration/);
    assert.equal(operationState({ ...facts, ...changes }, { settingsDirty: true }).canSaveSettings, true);
    assert.equal(state.canReboot, true, "missing wireless facts must not block unrelated writes");
  }
  for (const activity of [{ saving: true }, { uncertain: true }, { wirelessBusy: true }])
    assert.equal(operationState(facts, activity).canProvisionWireless, false);
  for (const changes of [{ msc: { enabled: true } }, { storage_stale: true }, { storage_stale: undefined },
    { hardware: { capabilities: 0x0e } }])
    assert.equal(operationState({ ...facts, ...changes }).canProvisionWireless, false, JSON.stringify(changes));
  assert.equal(operationState({ ...facts, hardware: { capabilities: 0x0e } }).wirelessBlockReason, null);
});

test("terminal effects describe reboot, save and Wi-Fi cancel without inventing other commands", () => {
  for (let opcode = 1; opcode <= 13; opcode++) {
    for (const status of ["completed", "failed", "busy", "invalid", "unsupported"]) {
      const completed = status === "completed";
      const effects = commandEffects({ opcode, status });
      assert.deepEqual(Object.keys(effects).sort(), ["completed", "failure", "reboot", "wifiCancel"]);
      assert.equal(effects.reboot, completed && [2, 5].includes(opcode));
      assert.equal(effects.wifiCancel, opcode === 10);
      assert.equal(effects.completed, completed);
      if (completed) assert.equal(effects.failure, null);
      else assert.match(effects.failure, new RegExp(`Command ${opcode} ${status}.*Retry explicitly`));
    }
  }
  assert.match(commandEffects({ opcode: 2, status: "failed", error: "storage_busy", detail: 2 }).failure,
    /storage_busy \(detail 2\)/);
  assert.doesNotMatch(commandEffects({ opcode: 2, status: "failed", error: "none", detail: 0 }).failure,
    /none|detail/);
});

test("one pure policy handles every local gate without changing board facts", () => {
  const facts = structuredClone(ready);
  assert.equal(operationState(ready).canReboot, true);
  for (const flag of ["uncertain", "rebootPending", "resyncing", "saving", "wirelessInFlight", "statusFailed"]) {
    const state = operationState(ready, { [flag]: true });
    assert.equal(state.canReboot, false, flag);
    assert.equal(state.settingsBusy, true, flag);
  }
  for (const flag of ["scanning", "radiosDirty", "settingsDirty", "wirelessDirty"])
    assert.equal(operationState(ready, { [flag]: true }).canReboot, true, flag);
  for (const changes of [{ connected: false }, { hardware: { capabilities: 0x8c } }, { storage_stale: true },
    { msc: null }, { msc: { enabled: true } }, { reboot_pending: true }, { command_outcome_uncertain: true },
    { outcome_uncertain: true }, { wireless_cleanup_required: true }])
    assert.equal(operationState({ ...ready, ...changes }).canReboot, false, JSON.stringify(changes));
  assert.deepEqual(ready, facts);
});

test("storage admission blocks reboot and save until USB ownership is returned", () => {
  assert.equal(operationState(ready).storageBlockReason, null);
  assert.equal(operationState(ready).storageStatusReady, true);
  assert.equal(operationState(ready).storageCommandPending, false);
  assert.equal(operationState({ ...ready, connected: false }).storageBlockReason, null);
  for (const [changes, reason] of [
    [{ storage_stale: true }, /Waiting for fresh storage status/],
    [{ msc: null }, /Waiting for fresh storage status/],
    [{ msc: { enabled: true } }, /Safely eject/],
    [{ msc: { enabled: false, transition_pending: true } }, /storage to become idle/],
  ]) {
    const projection = operationState({ ...ready, ...changes });
    assert.match(projection.storageBlockReason, reason);
    assert.equal(projection.storageCommandPending, true);
  }
});

test("recovery projection gives local and server uncertainty the same explicit admission", () => {
  const facts = { ...ready, command_resync_supported: true };
  for (const [snapshot, activity] of [
    [facts, { uncertain: true }], [{ ...facts, command_outcome_uncertain: true }, {}],
    [{ ...facts, outcome_uncertain: true }, {}], [{ ...facts, wireless_cleanup_required: true }, { uncertain: true }],
  ]) {
    assert.equal(operationState(snapshot, activity).recovery, "resync");
    assert.equal(operationState(snapshot, activity).canRecover, true);
    for (const flag of ["resyncing", "statusFailed", "saving", "wirelessInFlight"]) {
      assert.equal(operationState(snapshot, { ...activity, [flag]: true }).canRecover, false, flag);
    }
    assert.equal(operationState({ ...snapshot, connected: false }, activity).canRecover, false);
  }
  assert.equal(operationState({ ...facts, wireless_cleanup_required: true }).recovery, "cleanup");
  const unsupported = operationState(ready, { uncertain: true });
  assert.equal(unsupported.recovery, null);
  assert.equal(unsupported.canRecover, false);
  assert.equal(unsupported.canReboot, false);
});

test("tagged uncertainty settles only on the matching fresh evidence", () => {
  const settings = { system_clock_mhz: 160, sdcard_profile: 0, radios: 3 };
  const facts = { ...ready, settings };
  const command = recovery => ({ ...recovery, message: "uncertain" });
  assert.equal(commandSettled(null, facts), false);
  assert.equal(commandSettled(command({ kind: "resync" }), facts), false);
  assert.equal(commandSettled(command({ kind: "resync" }), { connected: false }), false);
  assert.equal(commandSettled(command({ kind: "reconnect" }), facts), false);
  for (const connected of [undefined, null, 0, "", "false"])
    assert.equal(commandSettled(command({ kind: "reconnect" }), { connected }), false);
  for (const reboot_pending of [undefined, null, 0, 1, "", "true"])
    assert.equal(commandSettled(command({ kind: "reconnect" }), { connected: true, reboot_pending }), false);
  assert.equal(commandSettled(command({ kind: "reconnect" }), { connected: false }), true);
  assert.equal(commandSettled(command({ kind: "reconnect" }), { ...facts, reboot_pending: true }), true);
  assert.equal(commandSettled(command({ kind: "settings", expected: settings }), facts), true);
  for (const key of Object.keys(settings)) {
    assert.equal(commandSettled(command({ kind: "settings", expected: { ...settings, [key]: 99 } }), facts), false);
  }
  assert.equal(commandSettled(command({ kind: "settings", expected: settings }), {}), false);
});

test("board command state tracks reboot progress and clears only settled uncertainty", () => {
  const state = createCommandState();
  assert.deepEqual(state, { uncertainCommand: null, rebootPending: null, commandFailure: null });
  assert.notStrictEqual(createCommandState(), state, "each board owns independent state");
  state.rebootPending = "requested";
  assert.equal(observeCommandStatus(state, ready), null);
  assert.equal(state.rebootPending, "requested", "an old connected poll cannot release a fresh request");
  observeCommandStatus(state, { ...ready, reboot_pending: true });
  assert.equal(state.rebootPending, "observed");
  observeCommandStatus(state, { connected: false });
  assert.equal(state.rebootPending, "disconnected");
  observeCommandStatus(state, ready);
  assert.equal(state.rebootPending, null);
  state.uncertainCommand = { kind: "reconnect", message: "uncertain" };
  assert.equal(observeCommandStatus(state, ready), null);
  assert.equal(state.uncertainCommand.kind, "reconnect");
  const settled = observeCommandStatus(state, { connected: false });
  assert.equal(settled.kind, "reconnect");
  assert.equal(state.uncertainCommand, null);
  state.uncertainCommand = { kind: "resync", message: "uncertain" };
  for (const snapshot of [ready, { connected: false }, { ...ready, reboot_pending: true }])
    assert.equal(observeCommandStatus(state, snapshot), null);
  assert.equal(state.uncertainCommand.kind, "resync", "only explicit Re-sync clears resync obligations");
});

test("known wireless cleanup blocks writes without inventing transaction uncertainty or locking selection", () => {
  const state = operationState({ ...ready, wireless_cleanup_required: true });
  assert.equal(state.outcomeUncertain, false);
  assert.equal(state.settingsBusy, true);
  assert.equal(state.canReboot, false);
  assert.equal(state.canProvisionWireless, false);
  assert.equal(state.boardSelectionBusy, false);
  for (const flag of ["resyncing", "scanning", "saving", "wirelessBusy"])
    assert.equal(operationState(ready, { [flag]: true }).boardSelectionBusy, true, flag);
});
