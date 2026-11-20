// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceActions } from "../../src/js/dashboard/device-actions.mjs";

function setup(context, fetchReply = async () => ({ ok: true, status: 200, json: async () => ({ accepted: true }) })) {
  const elements = new Map([
    ["#benchmark-size", { value: "32" }],
    ["#led-colour", { value: "5" }],
    ["#reboot-dialog", { open: false, showModal() { this.open = true; }, close() { this.open = false; } }],
    ["#reboot-board-target", { textContent: "" }],
    ["#reboot-consequence", { textContent: "" }],
    ["#msc-dialog", { open: false, showModal() { this.open = true; }, close() { this.open = false; } }],
    ["#msc-dialog-title", { textContent: "" }],
    ["#msc-warning", { textContent: "" }],
    ["#confirm-msc", { textContent: "" }],
  ]);
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { querySelector: selector => elements.get(selector) ?? null };
  const confirmations = [];
  globalThis.window = { confirm: message => { confirmations.push(message); return true; } };
  context.after(() => Object.assign(globalThis, previous));

  const calls = [];
  const published = [];
  const uncertain = [];
  const messages = [];
  const snapshot = { connected: true };
  let operations = { canStartBenchmark: true, canCancelBenchmark: true, canSetLed: true, canReboot: true,
    canEnableMsc: true, canReturnMsc: true };
  let selectedBoard = "board-a";
  let connectionGeneration = 3;
  const actions = createDeviceActions({
    getCurrentSnapshot: () => snapshot,
    getSelectedBoard: () => selectedBoard,
    getSelectedBoardLabel: () => `ESPForge / ${selectedBoard}`,
    getConnectionGeneration: () => connectionGeneration,
    operationState: () => operations,
    runCommandLifecycle: async (_options, run, failed) => {
      try { await run(); }
      catch (error) { failed(error); }
    },
    boardUrl: path => `${path}?board=board-a`,
    fetchWithDeadline: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return fetchReply(url, options, timeoutMs);
    },
    publishCommandResult: result => published.push(result),
    markCommandOutcomeUncertain: (error, message, recovery, boardId) => {
      uncertain.push({ error, message, recovery, boardId });
      return true;
    },
    uncertainMessage: (_error, fallback) => fallback,
    setSettingsMessage: message => messages.push(message),
  });
  return {
    actions, calls, confirmations, elements, messages, published, snapshot, uncertain,
    setOperations: next => { operations = next; },
    selectBoard: board => { selectedBoard = board; },
    disconnect: () => { connectionGeneration++; },
  };
}

test("benchmark actions require confirmation and send explicit start/cancel payloads", async context => {
  const { actions, calls, confirmations, published, setOperations } = setup(context);
  await actions.benchmark(true);
  assert.match(confirmations[0], /Write and verify 32 MiB/);
  assert.equal(calls[0].url, "/api/benchmark?board=board-a");
  assert.equal(calls[0].timeoutMs, 15000);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    start: true, size_mib: 32, confirm: true,
  });
  assert.deepEqual(published[0], { opcode: 4, status: "completed" });

  await actions.benchmark(false);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    start: false, size_mib: 0, confirm: false,
  });

  setOperations({ canStartBenchmark: false, canCancelBenchmark: true, canSetLed: false });
  await actions.benchmark(true);
  assert.equal(calls.length, 2, "stale operation state blocks the write before confirmation");
  assert.equal(confirmations.length, 1);
});

test("benchmark cancellation by the user sends no command", async context => {
  const { actions, calls } = setup(context);
  globalThis.window.confirm = () => false;
  await actions.benchmark(true);
  assert.equal(calls.length, 0);
});

test("LED changes require admission, publish acknowledgement and mark telemetry stale", async context => {
  const { actions, calls, published, snapshot, setOperations } = setup(context);
  setOperations({ canStartBenchmark: false, canCancelBenchmark: false, canSetLed: false });
  await actions.setLed();
  assert.equal(calls.length, 0, "stale or unsupported LED state blocks the request");
  setOperations({ canStartBenchmark: true, canCancelBenchmark: true, canSetLed: true });
  await actions.setLed();
  assert.equal(calls[0].url, "/api/led?board=board-a");
  assert.deepEqual(JSON.parse(calls[0].options.body), { colour: 5 });
  assert.deepEqual(published[0], { opcode: 1, status: "completed" });
  assert.equal(snapshot.telemetry_stale, true);
});

test("uncertain benchmark admission is surfaced without retrying", async context => {
  const failure = new TypeError("connection lost");
  const { actions, calls, uncertain } = setup(context, async () => { throw failure; });
  await actions.benchmark(true);
  assert.equal(calls.length, 1);
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].error, failure);
  assert.deepEqual(uncertain[0].recovery, { kind: "resync" });
  assert.equal(uncertain[0].boardId, "board-a");
});

test("MSC handoff requires dialog confirmation and sends explicit enable/return payloads", async context => {
  const { actions, calls, elements, published, snapshot } = setup(context);
  const dialog = elements.get("#msc-dialog");
  await actions.setMsc();
  assert.equal(calls.length, 0, "a closed dialog sends nothing");

  actions.requestMsc(true);
  assert.equal(dialog.open, true);
  assert.equal(elements.get("#confirm-msc").textContent, "Enable USB drive");
  await actions.setMsc();
  assert.equal(dialog.open, false);
  assert.equal(calls[0].url, "/api/msc?board=board-a");
  assert.deepEqual(JSON.parse(calls[0].options.body), { enabled: true, confirm_ejected: false });
  assert.deepEqual(published[0], { opcode: 3, status: "completed" });
  assert.equal(snapshot.storage_stale, true);

  actions.requestMsc(false);
  assert.match(elements.get("#msc-warning").textContent, /Safely eject/);
  await actions.setMsc();
  assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: false, confirm_ejected: true });
});

test("MSC confirmation is discarded after a board change or lost admission", async context => {
  const { actions, calls, elements, selectBoard, setOperations } = setup(context);
  actions.requestMsc(true);
  selectBoard("board-b");
  await actions.setMsc();
  assert.equal(calls.length, 0, "a dialog opened for another board never sends");
  assert.equal(elements.get("#msc-dialog").open, true);

  actions.requestMsc(true);
  setOperations({ canEnableMsc: false, canReturnMsc: false });
  await actions.setMsc();
  assert.equal(calls.length, 0);
  assert.equal(elements.get("#msc-dialog").open, false);
});

test("reboot confirmation records its board and expires after a disconnect", async context => {
  const { actions, calls, elements, disconnect } = setup(context);
  actions.confirmReboot(false);
  assert.match(elements.get("#reboot-board-target").textContent, /board-a/);
  disconnect();
  actions.invalidateConfirmation();
  await actions.rebootDevice();
  assert.equal(calls.length, 0);

  actions.confirmReboot(false);
  await actions.rebootDevice();
  assert.equal(calls.length, 1);
});
