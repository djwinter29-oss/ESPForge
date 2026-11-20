// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createWirelessTransport } from "../../src/js/dashboard/wireless-transport.mjs";

function setup(fetchReply) {
  const session = { selectedBoard: "board-a", selectionVersion: 1, commandChanges: 0 };
  const calls = [];
  const uncertain = [];
  const transport = createWirelessTransport({
    session: {
      boardUrl: (path, boardId) => `${path}?board=${boardId}`,
      commandChanged: () => { session.commandChanges++; },
      state: () => ({ selectedBoard: session.selectedBoard, selectionVersion: session.selectionVersion }),
    },
    fetchWithDeadline: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return fetchReply();
    },
    markCommandOutcomeUncertain: (error, _message, recovery, boardId) => {
      uncertain.push({ error, recovery, boardId });
      return true;
    },
  });
  return { calls, session, transport, uncertain };
}

test("a timed-out Wi-Fi test is recorded against its board and reported as uncertain", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const { calls, session, transport, uncertain } = setup(() => {
    session.selectedBoard = "board-b";
    throw timeout;
  });
  const phases = [];
  await assert.rejects(transport.test({ ssid: "lab", password: "secret" }, phase => phases.push(phase)),
    /Wi-Fi test timed out; result is uncertain/);
  assert.equal(calls.length, 1, "the test is never resent");
  assert.equal(calls[0].url, "/api/wireless/test?board=board-a");
  assert.equal(calls[0].timeoutMs, 40000);
  assert.deepEqual(uncertain, [{ error: timeout, recovery: { kind: "resync" }, boardId: "board-a" }]);
  assert.equal(session.commandChanges, 2, "status reads are fenced before and after the request");
  transport.reportPhase("connecting");
  assert.deepEqual(phases, [], "progress stops once the test settles");
});

test("progress reaches the active test and a non-confirming cancel is uncertain", async () => {
  /** @type {(value: unknown) => void} */
  let release = () => {};
  const { transport } = setup(() => new Promise(resolve => { release = resolve; }));
  const phases = [];
  const pending = transport.test({ ssid: "lab", password: "secret" }, phase => phases.push(phase));
  transport.reportPhase("associating");
  release({ ok: true, status: 200, json: async () => ({ test: {
    remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32), ipv4: "192.168.1.9",
  } }) });
  assert.deepEqual(await pending, {
    remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32), ipv4: "192.168.1.9",
  });
  assert.deepEqual(phases, ["associating"]);

  const cancelling = setup(async () => ({ ok: true, status: 200, json: async () => ({ cancelled: false }) }));
  await assert.rejects(cancelling.transport.cancelTest(), error => error.uncertain === true);
  assert.equal(cancelling.uncertain.length, 1);
});
