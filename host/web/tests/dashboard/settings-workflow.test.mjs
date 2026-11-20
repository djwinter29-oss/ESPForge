// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { hasUnknownOutcome } from "../../src/js/dashboard/command-lifecycle.mjs";
import { createSettingsWorkflow } from "../../src/js/dashboard/settings-workflow.mjs";

function setup(context, { wirelessDirty = false, wirelessDraft = false, reply } = {}) {
  const closeListeners = [];
  const attributes = {};
  const dialog = { open: false, attributes, showModal() { this.open = true; },
    close() { this.open = false; closeListeners.forEach(listener => listener()); },
    setAttribute(name, value) { attributes[name] = String(value); },
    addEventListener: (type, listener) => { if (type === "close") closeListeners.push(listener); } };
  const elements = new Map([
    ["#configuration-dialog", dialog],
    ["#configuration-wireless-warning", { hidden: true }],
    ["#configuration-dialog-profile", { textContent: "" }],
    ["#configuration-draft-warning", { hidden: true }],
    ["#configuration-dialog-board", { textContent: "" }],
    ["#configuration-wireless-row", { hidden: true }],
    ["#configuration-dialog-wireless", { textContent: "" }],
  ]);
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => elements.get(selector) ?? null };
  context.after(() => { globalThis.document = previous; });

  const snapshot = { connected: true, hardware: { capabilities: 0 },
    settings: { system_clock_mhz: 240, sdcard_profile: 0, radios: 0 } };
  const calls = [];
  const published = [];
  const uncertain = [];
  const finished = [];
  const messages = [];
  const workflow = createSettingsWorkflow({
    getCurrentSnapshot: () => snapshot,
    getSelectedBoardLabel: () => "ZephyrForge / test-board",
    wireless: {
      credentialActions: () => ({ wifi: "preserve", ble: "preserve" }),
      testedNetworkName: () => null,
      dirty: () => wirelessDirty,
      hasDraftEdits: () => wirelessDirty || wirelessDraft,
      finish: (saved, error) => finished.push({ saved, error }),
      request: () => ({ ssid: "lab" }),
      saveIdentity: () => "wireless",
      selectedRadios: saved => saved,
    },
    operationState: () => ({ canSaveSettings: true, saveBlockReason: null }),
    runCommandLifecycle: async (_options, run, failed) => {
      try { await run(); }
      catch (error) { failed(error); }
    },
    boardUrl: path => path,
    fetchWithDeadline: async (url, options) => {
      calls.push({ url, body: JSON.parse(String(options.body)) });
      return reply ? reply() : { ok: true, status: 200, json: async () => ({ settings: calls.at(-1).body }) };
    },
    publishCommandResult: result => published.push(result),
    markCommandOutcomeUncertain: (error, _message, recovery) => {
      if (!hasUnknownOutcome(error)) return false;
      uncertain.push(recovery);
      return true;
    },
    setMessage: message => messages.push(message),
    changed: () => {},
  });
  return { calls, dialog, elements, finished, messages, published, snapshot, uncertain, workflow };
}

test("save confirmation only describes warnings that are visible and applicable", context => {
  const plain = setup(context);
  plain.workflow.setClock("160");
  plain.workflow.confirm();
  const plainDescription = plain.dialog.attributes["aria-describedby"].split(" ");
  assert.deepEqual(plainDescription, ["configuration-dialog-summary", "configuration-warning"]);
  assert.equal(plain.elements.get("#configuration-draft-warning").hidden, true);
  plain.dialog.close();

  const draft = setup(context, { wirelessDraft: true });
  draft.workflow.setClock("160");
  draft.workflow.confirm();
  assert.ok(draft.dialog.attributes["aria-describedby"].includes("configuration-draft-warning"));
  assert.equal(draft.elements.get("#configuration-draft-warning").hidden, false);
});

test("a confirmed plain save sends the draft, acknowledges reboot and clears the draft", async context => {
  const { calls, dialog, elements, published, snapshot, workflow } = setup(context);
  workflow.setClock("160");
  assert.equal(workflow.dirty(), true);
  workflow.confirm();
  assert.equal(dialog.open, true);
  assert.equal(elements.get("#configuration-dialog-board").textContent, "ZephyrForge / test-board");
  await workflow.save();
  assert.deepEqual(calls, [{ url: "/api/settings", body: { system_clock_mhz: 160, sdcard_profile: 0, radios: 0 } }]);
  assert.deepEqual(published, [{ opcode: 5, status: "completed" }]);
  assert.equal(snapshot.settings.system_clock_mhz, 160);
  assert.equal(workflow.dirty(), false);
});

test("save is refused when the proposal changed after confirmation", async context => {
  const { calls, dialog, messages, workflow } = setup(context);
  workflow.setClock("160");
  workflow.confirm();
  workflow.setClock("80");
  await workflow.save();
  assert.equal(calls.length, 0);
  assert.match(messages.at(-1), /proposed configuration changed/);

  workflow.confirm();
  dialog.close();
  dialog.open = true;
  await workflow.save();
  assert.equal(calls.length, 0, "a dismissed confirmation cannot be reused");
});

test("a lost plain save waits for settings readback without resending", async context => {
  const { calls, uncertain, workflow } = setup(context, { reply: () => { throw new TypeError("lost"); } });
  workflow.setClock("160");
  workflow.confirm();
  await workflow.save();
  assert.equal(calls.length, 1);
  assert.deepEqual(uncertain, [{ kind: "settings",
    expected: { system_clock_mhz: 160, sdcard_profile: 0, radios: 0 } }]);
});

test("a lost combined save is reported uncertain and requires Re-sync", async context => {
  const { calls, finished, uncertain, workflow } = setup(context, {
    wirelessDirty: true, reply: () => { throw new TypeError("lost"); },
  });
  workflow.confirm();
  await workflow.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/wireless");
  assert.deepEqual(calls[0].body.board, { system_clock_mhz: 240, sdcard_profile: 0, radios: 0 });
  assert.deepEqual(finished, [{ saved: null,
    error: "Wireless provisioning outcome is uncertain; use Re-sync before retrying." }]);
  assert.deepEqual(uncertain, [{ kind: "resync" }]);
});
