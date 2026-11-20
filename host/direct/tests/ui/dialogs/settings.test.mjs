// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../../support/dom.mjs";
import { CAP } from "../../../web/js/protocol/constants.mjs";
import { mountSettingsDialogs } from "../../../web/js/ui/dialogs/settings.mjs";
import { createUiStore } from "../../../web/js/state/store.mjs";

test("configuration dialog confirms a settings save and reboot dialog dispatches reboot intent", async () => {
  const dom = createDocument();
  const previousDocument = globalThis.document;
  globalThis.document = dom.document;
  const calls = [];
  const updates = [];
  const session = {
    connectionGeneration: 1,
    state: { link: "usb", connected: true,
      hardware: { capabilities: CAP.WIRELESS, serial_number: "board-1", board_name: "Test board" },
      settings: { system_clock_mhz: 80, radios: 0 }, wireless: null },
    async saveConfiguration(intent) { calls.push(["save", intent]); return null; },
    async reboot(confirmed) { calls.push(["reboot", confirmed]); },
  };
  let wirelessDirty = false;
  const form = {
    signal: new AbortController().signal,
    dirty: () => wirelessDirty,
    saveBlockReason: () => null,
    request: () => null,
    finish: () => {},
  };
  const ui = createUiStore();
  const dialogs = mountSettingsDialogs({
    getSession: () => session,
    run: async operation => operation(),
    setUi: changes => { updates.push(changes); ui.dispatch({ type: "patch", changes }); },
    ui,
    wirelessForm: form,
    isDisposed: () => false,
  });
  try {
    dom.element("select#settings-clock").value = "160";
    await dom.fire("#settings-save", "click");
    assert.equal(dom.element("dialog#configuration-dialog").open, true);
    assert.match(dom.element("#configuration-board-target").textContent, /Test board.*board-1.*USB HID/);
    await dom.fire("#confirm-configuration", "click");
    assert.equal(calls[0][0], "save");
    assert.equal(calls[0][1].settings.system_clock_mhz, 160);
    assert.equal(dom.element("dialog#configuration-dialog").open, false);
    assert.ok(updates.some(update => update.settings_dirty === false));
    ui.dispatch({ type: "patch", changes: { settings_dirty: true } });
    wirelessDirty = true;
    session.state.wireless = { staged_mask: 1 };
    await dom.fire("#settings-reboot", "click");
    assert.match(dom.element("#reboot-consequence").textContent, /Staged wireless credentials/);
    assert.match(dom.element("#reboot-consequence").textContent, /Unsaved dashboard changes/);
    assert.match(dom.element("#reboot-board-target").textContent, /Test board.*board-1.*USB HID/);
    await dom.fire("#confirm-reboot", "click");
    assert.deepEqual(calls[1], ["reboot", true]);
  } finally {
    dialogs.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("settings and reboot confirmations refuse a replacement board", async () => {
  for (const action of ["save", "reboot"]) {
    const dom = createDocument();
    const previousDocument = globalThis.document;
    globalThis.document = dom.document;
    const errors = [];
    const calls = [];
    const session = {
      connectionGeneration: 1,
      state: { link: "usb", connected: true,
        hardware: { capabilities: CAP.WIRELESS, serial_number: "board-1" },
        settings: { system_clock_mhz: 80, radios: 0 }, wireless: null },
      async saveConfiguration() { calls.push("save"); return null; },
      async reboot() { calls.push("reboot"); },
    };
    const ui = createUiStore();
    const dialogs = mountSettingsDialogs({
      getSession: () => session,
      run: async operation => operation(),
      setUi: changes => { errors.push(changes.settings_message); ui.dispatch({ type: "patch", changes }); },
      ui,
      wirelessForm: { signal: new AbortController().signal, dirty: () => false,
        saveBlockReason: () => null, request: () => null, finish: () => {} },
      isDisposed: () => false,
    });
    try {
      if (action === "save") {
        await dom.fire("#settings-save", "click");
        session.connectionGeneration++;
        session.state.hardware.serial_number = "board-2";
        await dom.fire("#confirm-configuration", "click");
      } else {
        await dom.fire("#settings-reboot", "click");
        session.state.hardware.serial_number = "board-2";
        await dom.fire("#confirm-reboot", "click");
      }
      assert.deepEqual(calls, []);
      assert.match(errors.at(-1), /Board changed/);
    } finally {
      dialogs.close();
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  }
});
