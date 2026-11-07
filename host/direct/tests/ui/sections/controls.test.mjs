// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { deriveClockOptions, deriveControlsViewModel } from "../../../web/js/ui/sections/controls.mjs";
import { deriveOperationEligibility } from "../../../web/js/state/selectors.mjs";
import { snapshot } from "../../support/view.mjs";

const ui = (state, changes = {}) => ({ eligibility: deriveOperationEligibility(state), formBusy: false,
  settingsMessage: null, bleName: null, settingsDirty: true, wirelessDirty: false, wirelessSaveBlockReason: null,
  ...changes });
const environment = { secure: true, hid: true, ble: true };

test("ESP32-S3 clock choices are Default, 80, 160 and 240 MHz and keep an unsupported saved value visible", () => {
  assert.deepEqual(deriveClockOptions("ESP32-S3", 240).choices.map(([value]) => value), [0, 80, 160, 240]);
  assert.equal(deriveClockOptions("ESP32-S3", 0).choices[0][1], "Default (240 MHz)");
  assert.deepEqual(deriveClockOptions("ESP32-S3", 200).choices.at(-1), [200, "200 MHz (saved; unsupported)", true]);
  assert.deepEqual(deriveClockOptions(null, 0).choices, [[0, "Default"]]);
});

test("Bluetooth keeps clock save and reboot available while radios and credentials stay USB-only", () => {
  const state = { ...snapshot(), link: "ble", settings_supported: true };
  const model = deriveControlsViewModel(state, ui(state), environment);
  assert.equal(model.disabled["settings-save"], false);
  assert.equal(model.disabled["settings-reboot"], false);
  assert.match(model.text["settings-note"], /radio and credential provisioning remain USB-only/);
  assert.equal(model.disabled["usb-connect"], true);
});

test("save and reboot wait for fresh storage and name the same reason the session would", () => {
  const state = { ...snapshot(), link: "usb", settings_supported: true, freshness: { 3: "fresh", 10: "stale" } };
  const model = deriveControlsViewModel(state, ui(state), environment);
  assert.equal(model.disabled["settings-save"], true);
  assert.equal(model.titles["settings-reboot"], "Fresh storage status required");
  assert.equal(model.text["settings-note"], "Waiting for fresh storage status.");
  const busy = deriveControlsViewModel(state, ui(state, { formBusy: true }), environment);
  assert.equal(busy.titles["settings-save"], "Finish the wireless operation first.");
  const blocked = deriveControlsViewModel({ ...snapshot(), link: "usb", settings_supported: true },
    ui(snapshot(), { wirelessDirty: true, wirelessSaveBlockReason: "Test the network first." }), environment);
  assert.equal(blocked.titles["settings-save"], "Test the network first.");
  assert.equal(blocked.disabled["settings-save"], true);
});

test("unsupported browsers explain the WebHID and Web Bluetooth requirements", () => {
  const state = { ...snapshot(), connected: false, link: "usb" };
  const model = deriveControlsViewModel(state, ui(state), { secure: false, hid: false, ble: false });
  assert.match(model.text["usb-connection-status"], /USB HID requires/);
  assert.match(model.text["bluetooth-connection-status"], /Web Bluetooth requires/);
  assert.equal(model.disabled["usb-connect"], true);
});
