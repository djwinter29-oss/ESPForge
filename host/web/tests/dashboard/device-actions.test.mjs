// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceActions } from "../../src/js/dashboard/device-actions.mjs";

function setup(context, fetchReply = async () => ({ ok: true, status: 200, json: async () => ({ accepted: true }) })) {
  const elements = new Map([
    ["#benchmark-size", { value: "32" }],
    ["#led-colour", { value: "5" }],
    ["#msc-dialog", { open: false, showModal() { this.open = true; }, close() { this.open = false; } }],
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
  let operations = { canStartBenchmark: true, canCancelBenchmark: true, canSetLed: true };
  const actions = createDeviceActions({
    getCurrentSnapshot: () => snapshot,
    getSelectedBoard: () => "board-a",
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
