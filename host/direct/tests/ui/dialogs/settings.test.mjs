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
    state: { link: "usb", connected: true, hardware: { capabilities: CAP.WIRELESS },
      settings: { system_clock_mhz: 80, radios: 0 }, wireless: null },
    async saveConfiguration(intent) { calls.push(["save", intent]); return null; },
    async reboot(confirmed) { calls.push(["reboot", confirmed]); },
  };
  const form = {
    signal: new AbortController().signal,
    dirty: () => false,
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
    await dom.fire("#confirm-configuration", "click");
    assert.equal(calls[0][0], "save");
    assert.equal(calls[0][1].settings.system_clock_mhz, 160);
    assert.equal(dom.element("dialog#configuration-dialog").open, false);
    assert.ok(updates.some(update => update.settings_dirty === false));
    await dom.fire("#settings-reboot", "click");
    await dom.fire("#confirm-reboot", "click");
    assert.deepEqual(calls[1], ["reboot", true]);
  } finally {
    dialogs.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
